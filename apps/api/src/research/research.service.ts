import { InjectQueue } from "@nestjs/bullmq";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  backtestsRepository,
  instrumentsRepository,
  journalEventsRepository,
  researchRepository,
  strategiesRepository,
  ResearchBudgetExceededError,
  ResearchStageOrderError,
} from "@trading-copilot/database";
import { assertSampleSizeGuardrails, buildResearchDataSummary } from "@trading-copilot/analytics";
import {
  RESEARCH_AGENT_QUEUE,
  RUN_RESEARCH_AGENT_JOB,
  type CreateResearchExperimentRequestInput,
  type GenerateResearchHypothesisRequestInput,
  type ResearchAgentJobPayload,
} from "@trading-copilot/shared-types";
import type { AgentExecution, ResearchExperiment, ResearchHypothesis } from "@trading-copilot/trading-domain";

/** Container Strategy key every AI-proposed StrategyDefinition is versioned under. See docs/ai-research.md. */
const AI_GENERATED_STRATEGY_KEY = "ai-generated-dsl-v1";

/** Configurable via env; a conservative default keeps an unattended loop from running up real API cost. */
function getDailyTokenBudget(): number {
  const raw = process.env.RESEARCH_DAILY_TOKEN_BUDGET;
  return raw ? Number.parseInt(raw, 10) : 200_000;
}

/**
 * Repositories are plain module-level imports here, called directly
 * (`researchRepository.foo(...)`), not constructor-injected. This mirrors
 * every other service in apps/api (see backtest.service.ts, setup.service.ts,
 * analytics.service.ts): none of them take a repository via the constructor,
 * DI-token or otherwise. Only the BullMQ queue is constructor-injected, via
 * `@InjectQueue`, matching BacktestService exactly.
 */
@Injectable()
export class ResearchService {
  constructor(
    @InjectQueue(RESEARCH_AGENT_QUEUE)
    private readonly agentQueue: Queue<ResearchAgentJobPayload>,
  ) {}

  /**
   * Enforces the daily token/cost budget (docs/ai-research.md "Cost and
   * safety controls") before enqueueing a new AgentExecution job. An LLM
   * call is neither free nor safe to retry automatically (see
   * RESEARCH_AGENT_JOB_OPTIONS's attempts: 1), so this check runs before any
   * spend is committed, not after.
   */
  async generateHypothesis(input: GenerateResearchHypothesisRequestInput): Promise<AgentExecution> {
    const spend = await researchRepository.getTodayResearchSpend();
    const budget = getDailyTokenBudget();
    if (spend.tokensUsed >= budget) {
      throw new ResearchBudgetExceededError(
        `today's usage (${spend.tokensUsed} tokens) has already met the daily budget (${budget} tokens)`,
      );
    }

    const trades = await researchRepository.listEnrichedJournalTradesForResearch({
      strategyId: input.strategyId,
      instrumentId: input.instrumentId,
    });
    const summary = buildResearchDataSummary(trades);

    const provider = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC" : "MOCK";
    const execution = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider,
      model: provider === "ANTHROPIC" ? "claude-sonnet-5" : "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: summary as unknown as Record<string, unknown>,
    });

    await this.agentQueue.add(RUN_RESEARCH_AGENT_JOB, { agentExecutionId: execution.id });

    return execution;
  }

  listHypotheses(): Promise<ResearchHypothesis[]> {
    return researchRepository.listResearchHypotheses();
  }

  async getHypothesis(id: string) {
    const hypothesis = await researchRepository.getResearchHypothesis(id);
    if (!hypothesis) {
      throw new NotFoundException(`ResearchHypothesis ${id} not found`);
    }
    const experiments = await researchRepository.listResearchExperimentsForHypothesis(id);
    const agentExecution = await researchRepository.getAgentExecution(hypothesis.agentExecutionId);
    return { hypothesis, experiments, agentExecution };
  }

  /**
   * Creates the Backtest this experiment runs (reusing the unmodified
   * backtest pipeline entirely), reuses (or, only the first time this
   * hypothesis is tested, creates) the one StrategyVersion this hypothesis
   * is tracked under (status DISCOVERED, sourceHypothesisId set,
   * "ai-generated-dsl-v1" key: see findStrategyVersionBySourceHypothesis's
   * doc comment in strategies.ts for why every stage of one hypothesis's
   * pipeline must share a single StrategyVersion row, not a fresh one per
   * stage), and the ResearchExperiment row itself. Dataset-role stage
   * ordering and the final-test reuse safeguard are both enforced inside
   * researchRepository.createResearchExperiment (Task 5).
   */
  async createExperiment(
    hypothesisId: string,
    input: CreateResearchExperimentRequestInput,
  ): Promise<ResearchExperiment> {
    const hypothesis = await researchRepository.getResearchHypothesis(hypothesisId);
    if (!hypothesis) {
      throw new NotFoundException(`ResearchHypothesis ${hypothesisId} not found`);
    }

    if (input.datasetRole !== "RESEARCH") {
      // Sample-size guardrails (docs/research-methodology.md "Sample size
      // guardrails"), checked over every closed journal trade in the system
      // rather than scoped to this hypothesis's own strategy/instrument.
      // ResearchHypothesis carries no strategyId/instrumentId column (its
      // proposedStrategyDefinition is a freeform StrategyDefinition
      // document, not yet tied to a concrete instrument until this very
      // call creates a Backtest for one), so there is no narrower
      // population available to query. assertSampleSizeGuardrails' own doc
      // comment in packages/analytics/src/research-summary.ts confirms this
      // is the intended, system-wide check: whether the trading system as a
      // whole has matured enough data to justify a riskier (non-RESEARCH)
      // dataset stage for ANY hypothesis, not a per-hypothesis measure. This
      // is a known scope limitation, not an oversight.
      const priorTrades = await researchRepository.listEnrichedJournalTradesForResearch({
        windowEnd: new Date(input.datasetWindowStart),
      });
      const guardrails = assertSampleSizeGuardrails(buildResearchDataSummary(priorTrades));
      if (!guardrails.passes) {
        // ResearchStageOrderError, not ResearchBudgetExceededError: this is
        // a precondition on advancing an experiment's dataset stage (the
        // same family of check as the RESEARCH -> VALIDATION -> FINAL_TEST
        // -> WALK_FORWARD ordering researchRepository.createResearchExperiment
        // itself enforces), not a token/cost budget concern. See that error
        // class's doc comment in packages/database/src/errors.ts.
        throw new ResearchStageOrderError(
          hypothesisId,
          input.datasetRole,
          `sample-size guardrails not met: ${guardrails.reasons.join("; ")}`,
        );
      }
    }

    const instrument = await instrumentsRepository.getInstrument(input.instrumentId);
    if (!instrument) {
      throw new NotFoundException(`Instrument ${input.instrumentId} not found`);
    }

    let strategyVersion = await strategiesRepository.findStrategyVersionBySourceHypothesis(hypothesisId);
    if (!strategyVersion) {
      let strategy = await strategiesRepository.getStrategyByKey(AI_GENERATED_STRATEGY_KEY);
      if (!strategy) {
        strategy = await strategiesRepository.createStrategy({
          key: AI_GENERATED_STRATEGY_KEY,
          name: "AI-generated DSL strategies",
          description: "Container Strategy for every AI-proposed StrategyDefinition. See docs/ai-research.md.",
        });
      }

      strategyVersion = await strategiesRepository.createStrategyVersion({
        strategyId: strategy.id,
        version: hypothesis.id,
        name: hypothesis.title,
        description: hypothesis.statement,
        parameters: hypothesis.proposedStrategyDefinition,
        status: "DISCOVERED",
        sourceHypothesisId: hypothesis.id,
      });
    }

    const backtest = await backtestsRepository.createBacktest({
      strategyVersionId: strategyVersion.id,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      startDate: new Date(input.datasetWindowStart),
      endDate: new Date(input.datasetWindowEnd),
      assumptions: {
        commissionPerContract: instrument.commissionPerContract.toString(),
        slippageTicks: input.slippageTicks,
        riskPercentage: input.riskPercentage,
        initialBalance: input.initialBalance,
      },
    });

    const experiment = await researchRepository.createResearchExperiment({
      hypothesisId,
      datasetRole: input.datasetRole,
      datasetWindowStart: new Date(input.datasetWindowStart),
      datasetWindowEnd: new Date(input.datasetWindowEnd),
      backtestId: backtest.id,
    });

    await journalEventsRepository.createJournalEvent({
      eventType: "RESEARCH_EXPERIMENT_CREATED",
      entityType: "RESEARCH_EXPERIMENT",
      entityId: experiment.id,
      instrumentId: input.instrumentId,
      strategyId: strategyVersion.strategyId,
      strategyVersionId: strategyVersion.id,
      metadata: { hypothesisId, datasetRole: experiment.datasetRole, backtestId: backtest.id },
    });

    return experiment;
  }

  /**
   * Human-triggered only (see markPaperCandidateRequestSchema's
   * confirmedByHuman: true literal). Nothing in this service auto-promotes
   * a StrategyVersion. Requires, in order:
   *
   * 1. A COMPLETED WALK_FORWARD experiment and a COMPLETED FINAL_TEST
   *    experiment to already exist for this hypothesis.
   * 2. `strategyVersionId` to actually be the StrategyVersion this
   *    hypothesis produced (via findStrategyVersionBySourceHypothesis), not
   *    merely some unrelated StrategyVersion that independently happens to
   *    be WALK_FORWARD. Without this check, step 1's two-experiment gate
   *    would be meaningless: it would only prove hypothesisId has
   *    qualifying experiments, never that strategyVersionId is the
   *    strategy those experiments were actually run against.
   * 3. Sample-size guardrails to pass over this hypothesis's combined
   *    FINAL_TEST + WALK_FORWARD evaluation window (see the inline comment
   *    below for why RESEARCH/VALIDATION are deliberately excluded), per
   *    docs/research-methodology.md and assertSampleSizeGuardrails' own doc
   *    comment in packages/analytics/src/research-summary.ts, both of which
   *    document this guardrail as gating the PAPER_CANDIDATE transition,
   *    not only experiment creation.
   *
   * Only once all three pass does this call the atomic conditional update
   * (status must currently be WALK_FORWARD): see
   * strategiesRepository.markPaperCandidate's doc comment, following the
   * exact atomic-updateMany-then-recheck pattern from journal-trades.ts's
   * closeJournalTrade (the Milestone 6 technical-debt pass).
   */
  async markPaperCandidate(hypothesisId: string, strategyVersionId: string): Promise<void> {
    const experiments = await researchRepository.listResearchExperimentsForHypothesis(hypothesisId);
    const hasCompletedFinalTest = experiments.some((e) => e.datasetRole === "FINAL_TEST" && e.status === "COMPLETED");
    const hasCompletedWalkForward = experiments.some(
      (e) => e.datasetRole === "WALK_FORWARD" && e.status === "COMPLETED",
    );
    if (!hasCompletedFinalTest || !hasCompletedWalkForward) {
      throw new ConflictException(
        "PAPER_CANDIDATE requires a COMPLETED FINAL_TEST experiment and a COMPLETED WALK_FORWARD experiment",
      );
    }

    // Ownership check (see the doc comment above, point 2). This is the fix
    // for the reviewed BLOCKER: `strategyVersionId` is a caller-supplied URL
    // param and must be verified against what this hypothesis actually
    // produced, not trusted as-is.
    const ownedVersion = await strategiesRepository.findStrategyVersionBySourceHypothesis(hypothesisId);
    if (!ownedVersion || ownedVersion.id !== strategyVersionId) {
      throw new ConflictException(
        `StrategyVersion ${strategyVersionId} does not belong to hypothesis ${hypothesisId}`,
      );
    }

    // Sample-size guardrails over the combined dataset window (point 3
    // above). Scoped to only the FINAL_TEST and WALK_FORWARD experiments
    // (not RESEARCH/VALIDATION): this guardrail exists to gate confidence in
    // the evaluation data a strategy is being promoted on, so it must be
    // checked against the actual held-out evaluation window, not widened
    // with the earlier exploratory/training-stage window. Including
    // RESEARCH/VALIDATION would let a hypothesis borrow trade volume/date
    // span from its own training period to satisfy a guardrail meant to
    // gate the evaluation stage, making it easier (not harder) to pass — the
    // wrong direction for a safety gate. `hasCompletedFinalTest`/
    // `hasCompletedWalkForward` above already guarantee at least one
    // qualifying experiment of each role exists. Reuses the same unscoped,
    // system-wide trade query as createExperiment's guardrail check (see
    // that method's doc comment): ResearchHypothesis/ResearchExperiment
    // carry no strategyId/instrumentId column to scope by.
    const evaluationExperiments = experiments.filter(
      (e) => e.datasetRole === "FINAL_TEST" || e.datasetRole === "WALK_FORWARD",
    );
    const windowStart = new Date(Math.min(...evaluationExperiments.map((e) => e.datasetWindowStart.getTime())));
    const windowEnd = new Date(Math.max(...evaluationExperiments.map((e) => e.datasetWindowEnd.getTime())));
    const trades = await researchRepository.listEnrichedJournalTradesForResearch({ windowStart, windowEnd });
    const guardrails = assertSampleSizeGuardrails(buildResearchDataSummary(trades));
    if (!guardrails.passes) {
      // ConflictException, not ResearchStageOrderError: unlike
      // createExperiment (which really is creating a new ResearchExperiment,
      // so ResearchStageOrderError's "Cannot create a {role} experiment..."
      // message is accurate), this method never creates an experiment, it
      // transitions a StrategyVersion's status. Reusing ResearchStageOrderError
      // here would produce a misleading message. ConflictException also
      // keeps this method internally consistent: all three of its
      // precondition failures (missing experiments, ownership mismatch,
      // guardrails) throw the same exception type.
      throw new ConflictException(
        `PAPER_CANDIDATE requires sample-size guardrails to pass over the combined dataset window: ${guardrails.reasons.join("; ")}`,
      );
    }

    const updated = await strategiesRepository.markPaperCandidate(strategyVersionId);
    if (!updated) {
      throw new ConflictException(
        `StrategyVersion ${strategyVersionId} is not currently WALK_FORWARD, cannot mark PAPER_CANDIDATE`,
      );
    }
  }
}
