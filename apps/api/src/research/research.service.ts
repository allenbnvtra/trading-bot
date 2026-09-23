import { InjectQueue } from "@nestjs/bullmq";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  backtestsRepository,
  instrumentsRepository,
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

    return researchRepository.createResearchExperiment({
      hypothesisId,
      datasetRole: input.datasetRole,
      datasetWindowStart: new Date(input.datasetWindowStart),
      datasetWindowEnd: new Date(input.datasetWindowEnd),
      backtestId: backtest.id,
    });
  }

  /**
   * Human-triggered only (see markPaperCandidateRequestSchema's
   * confirmedByHuman: true literal). Nothing in this service auto-promotes
   * a StrategyVersion. Requires a COMPLETED WALK_FORWARD experiment and a
   * COMPLETED FINAL_TEST experiment to already exist for this hypothesis.
   * Uses an atomic conditional update (status must currently be
   * WALK_FORWARD): see strategiesRepository.markPaperCandidate's doc
   * comment, following the exact atomic-updateMany-then-recheck pattern
   * from journal-trades.ts's closeJournalTrade (the Milestone 6
   * technical-debt pass).
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

    const updated = await strategiesRepository.markPaperCandidate(strategyVersionId);
    if (!updated) {
      throw new ConflictException(
        `StrategyVersion ${strategyVersionId} is not currently WALK_FORWARD, cannot mark PAPER_CANDIDATE`,
      );
    }
  }
}
