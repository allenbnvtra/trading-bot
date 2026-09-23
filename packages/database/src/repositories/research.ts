import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import type { EnrichedJournalTrade } from "@trading-copilot/analytics";
import type {
  AgentExecution,
  AIProviderType,
  HypothesisConfidence,
  ResearchDatasetRole,
  ResearchExperiment,
  ResearchHypothesis,
} from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { FinalTestAlreadySpentError, NotFoundError, ResearchStageOrderError } from "../errors";
import { mapAgentExecution, mapJournalTrade, mapMarketSnapshot, mapResearchExperiment, mapResearchHypothesis } from "../mappers";
import { createBacktest, type CreateBacktestInput } from "./backtests";
import { createJournalEvent } from "./journal-events";

const DATASET_ROLE_ORDER: ResearchDatasetRole[] = ["RESEARCH", "VALIDATION", "FINAL_TEST", "WALK_FORWARD"];

/**
 * Mirrors journal-trades.ts's / inbound-webhook-events.ts's /
 * trade-screenshots.ts's isUniqueConstraintViolation exactly: a type-safe
 * P2002 check that also verifies the violated constraint is genuinely the
 * one this call cares about (`error.meta.target` includes every field in
 * `fields`), rather than treating any P2002 on the table as a match.
 * `meta.target` is an array of column names, not a single string, even for
 * a raw-SQL partial unique index with no matching `@@unique` in
 * schema.prisma (confirmed live against Postgres by journal-trades.ts's
 * precedent for `JournalTrade_setupId_active_decision_key`, and the same
 * holds here for `ResearchExperiment_hypothesis_final_test_key`, whose sole
 * indexed column is `hypothesisId`).
 */
function isUniqueConstraintViolation(error: unknown, fields: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    fields.every((field) => (error.meta!.target as unknown[]).includes(field))
  );
}

async function createAgentExecution(input: {
  agentType: "RESEARCH";
  provider: AIProviderType;
  model: string;
  promptVersion: string;
  inputSummary: Record<string, unknown>;
}): Promise<AgentExecution> {
  const row = await prisma.agentExecution.create({
    data: {
      agentType: input.agentType,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      inputSummary: input.inputSummary as Prisma.InputJsonValue,
      status: "RUNNING",
    },
  });
  return mapAgentExecution(row);
}

async function markAgentExecutionSucceeded(
  id: string,
  output: {
    outputRaw: string;
    outputParsed: Record<string, unknown>;
    tokensInput: number;
    tokensOutput: number;
    costUsd: Decimal;
  },
): Promise<AgentExecution> {
  const row = await prisma.agentExecution.update({
    where: { id },
    data: {
      status: "SUCCEEDED",
      outputRaw: output.outputRaw,
      outputParsed: output.outputParsed as Prisma.InputJsonValue,
      tokensInput: output.tokensInput,
      tokensOutput: output.tokensOutput,
      costUsd: output.costUsd.toString(),
      completedAt: new Date(),
    },
  });
  return mapAgentExecution(row);
}

async function markAgentExecutionFailed(
  id: string,
  failure: { outputRaw: string | null; errorMessage: string },
): Promise<AgentExecution> {
  const row = await prisma.agentExecution.update({
    where: { id },
    data: {
      status: "FAILED",
      outputRaw: failure.outputRaw,
      errorMessage: failure.errorMessage,
      completedAt: new Date(),
    },
  });
  return mapAgentExecution(row);
}

async function getAgentExecution(id: string): Promise<AgentExecution | null> {
  const row = await prisma.agentExecution.findUnique({ where: { id } });
  return row ? mapAgentExecution(row) : null;
}

async function listAgentExecutions(): Promise<AgentExecution[]> {
  const rows = await prisma.agentExecution.findMany({ orderBy: { startedAt: "desc" } });
  return rows.map(mapAgentExecution);
}

async function createResearchHypothesis(input: {
  agentExecutionId: string;
  title: string;
  statement: string;
  rationale: string;
  confidence: HypothesisConfidence;
  sourceDataSummary: Record<string, unknown>;
  proposedStrategyDefinition: Record<string, unknown>;
}): Promise<ResearchHypothesis> {
  const row = await prisma.researchHypothesis.create({
    data: {
      agentExecutionId: input.agentExecutionId,
      title: input.title,
      statement: input.statement,
      rationale: input.rationale,
      confidence: input.confidence,
      sourceDataSummary: input.sourceDataSummary as Prisma.InputJsonValue,
      proposedStrategyDefinition: input.proposedStrategyDefinition as Prisma.InputJsonValue,
      status: "PROPOSED",
    },
  });
  return mapResearchHypothesis(row);
}

async function getResearchHypothesis(id: string): Promise<ResearchHypothesis | null> {
  const row = await prisma.researchHypothesis.findUnique({ where: { id } });
  return row ? mapResearchHypothesis(row) : null;
}

async function listResearchHypotheses(): Promise<ResearchHypothesis[]> {
  const rows = await prisma.researchHypothesis.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(mapResearchHypothesis);
}

/** Anything that can run the precondition reads: the prisma singleton or a `$transaction` callback's `tx`. */
type ResearchPreconditionClient = Pick<Prisma.TransactionClient, "researchExperiment" | "researchHypothesis">;

/** Dataset roles whose window must also start at or after the data that generated the hypothesis. */
const HOLDOUT_GUARDED_ROLES: ReadonlySet<ResearchDatasetRole> = new Set(["FINAL_TEST", "WALK_FORWARD"]);

/** The non-terminal experiment statuses a lifecycle transition may start from. */
const ACTIVE_EXPERIMENT_STATUSES = ["QUEUED", "RUNNING"] as const;

export interface ResearchExperimentPreconditionInput {
  hypothesisId: string;
  datasetRole: ResearchDatasetRole;
  datasetWindowStart: Date;
  datasetWindowEnd: Date;
}

/**
 * Reads `sourceDataSummary.sampleWindowEnd` (an ISO string after the JSON
 * round-trip; see buildResearchDataSummary in packages/analytics). Returns
 * null when absent or null (a zero-trade hypothesis, or a summary written
 * without the field), meaning there is nothing to guard against. Fails
 * closed on a present-but-unparseable value rather than silently skipping
 * the holdout check.
 */
function extractSampleWindowEnd(hypothesisId: string, role: ResearchDatasetRole, summary: Prisma.JsonValue): Date | null {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return null;
  }
  const raw = (summary as Prisma.JsonObject).sampleWindowEnd;
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = typeof raw === "string" ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new ResearchStageOrderError(
      hypothesisId,
      role,
      `hypothesis sourceDataSummary.sampleWindowEnd is not a valid ISO date (${JSON.stringify(raw)}), cannot verify the holdout window`,
    );
  }
  return parsed;
}

/**
 * Every precondition for creating a ResearchExperiment, as read-only
 * checks. Runs twice on the real path: once from ResearchService before
 * any row is written (fast-fail, so a rejected request creates nothing,
 * not even the hypothesis's StrategyVersion), and again inside
 * createResearchExperiment's transaction (authoritative). All rejections
 * are ResearchStageOrderError (409):
 *
 * 1. Well-formed window: datasetWindowEnd must be after datasetWindowStart
 *    (also validated at the HTTP boundary; repeated here because check 3
 *    depends on it).
 * 2. Stage order (RESEARCH -> VALIDATION -> FINAL_TEST -> WALK_FORWARD):
 *    the immediately-prior role must have a COMPLETED experiment.
 * 3. Window isolation (docs/research-methodology.md, "each stage uses data
 *    the previous stage did not"): for any role after RESEARCH, the new
 *    window must start at or after the latest datasetWindowEnd of every
 *    non-FAILED experiment of this hypothesis, any role. FAILED rows are
 *    excluded because their data never produced a result that shaped the
 *    hypothesis's progression.
 * 4. Holdout (FINAL_TEST/WALK_FORWARD only): the window must start at or
 *    after the hypothesis's sourceDataSummary.sampleWindowEnd, i.e. after
 *    the journal data the hypothesis itself was generated from. Skipped
 *    when that value is null (zero-trade hypothesis).
 */
async function assertResearchExperimentPreconditions(
  input: ResearchExperimentPreconditionInput,
  client: ResearchPreconditionClient = prisma,
): Promise<void> {
  const { hypothesisId, datasetRole } = input;

  if (input.datasetWindowEnd.getTime() <= input.datasetWindowStart.getTime()) {
    throw new ResearchStageOrderError(hypothesisId, datasetRole, "datasetWindowEnd must be after datasetWindowStart");
  }

  const roleIndex = DATASET_ROLE_ORDER.indexOf(datasetRole);
  if (roleIndex > 0) {
    const priorRole = DATASET_ROLE_ORDER[roleIndex - 1]!;
    const priorCompleted = await client.researchExperiment.findFirst({
      where: { hypothesisId, datasetRole: priorRole, status: "COMPLETED" },
    });
    if (!priorCompleted) {
      throw new ResearchStageOrderError(
        hypothesisId,
        datasetRole,
        `no COMPLETED ${priorRole} experiment exists yet for this hypothesis`,
      );
    }

    const latest = await client.researchExperiment.aggregate({
      where: { hypothesisId, status: { not: "FAILED" } },
      _max: { datasetWindowEnd: true },
    });
    const latestEnd = latest._max.datasetWindowEnd;
    if (latestEnd && input.datasetWindowStart.getTime() < latestEnd.getTime()) {
      throw new ResearchStageOrderError(
        hypothesisId,
        datasetRole,
        `dataset window must not overlap an earlier stage: datasetWindowStart ${input.datasetWindowStart.toISOString()} ` +
          `is before the latest non-FAILED experiment window end ${latestEnd.toISOString()} for this hypothesis`,
      );
    }
  }

  if (HOLDOUT_GUARDED_ROLES.has(datasetRole)) {
    const hypothesis = await client.researchHypothesis.findUnique({
      where: { id: hypothesisId },
      select: { sourceDataSummary: true },
    });
    if (!hypothesis) {
      throw new NotFoundError("ResearchHypothesis", hypothesisId);
    }
    const sampleWindowEnd = extractSampleWindowEnd(hypothesisId, datasetRole, hypothesis.sourceDataSummary);
    if (sampleWindowEnd && input.datasetWindowStart.getTime() < sampleWindowEnd.getTime()) {
      throw new ResearchStageOrderError(
        hypothesisId,
        datasetRole,
        `${datasetRole} window must be out-of-sample relative to the data that generated this hypothesis: ` +
          `datasetWindowStart ${input.datasetWindowStart.toISOString()} is before the hypothesis's ` +
          `sourceDataSummary.sampleWindowEnd ${sampleWindowEnd.toISOString()}`,
      );
    }
  }
}

/**
 * Creates a ResearchExperiment (status QUEUED) and, when `backtest` is
 * given, the Backtest it runs, in ONE transaction: every precondition in
 * assertResearchExperimentPreconditions is re-checked inside it, and the
 * final-test reuse safeguard (the partial unique index, P2002 translated to
 * FinalTestAlreadySpentError) fires on the experiment insert. Any rejection
 * therefore rolls back the Backtest too, so no orphan Backtest row is ever
 * left behind (the MEDIUM-6 finding from the Milestone 7 final review).
 * The caller enqueues the backtest job only after this commits.
 *
 * `backtest` is optional only so repository-level tests can exercise the
 * stage logic without a Backtest; ResearchService always passes it.
 */
async function createResearchExperiment(input: {
  hypothesisId: string;
  datasetRole: ResearchDatasetRole;
  datasetWindowStart: Date;
  datasetWindowEnd: Date;
  backtest?: CreateBacktestInput;
}): Promise<ResearchExperiment> {
  try {
    return await prisma.$transaction(async (tx) => {
      await assertResearchExperimentPreconditions(input, tx);

      const backtest = input.backtest ? await createBacktest(input.backtest, tx) : null;

      const row = await tx.researchExperiment.create({
        data: {
          hypothesisId: input.hypothesisId,
          datasetRole: input.datasetRole,
          datasetWindowStart: input.datasetWindowStart,
          datasetWindowEnd: input.datasetWindowEnd,
          backtestId: backtest?.id ?? null,
          status: "QUEUED",
        },
      });
      return mapResearchExperiment(row);
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error, ["hypothesisId"])) {
      throw new FinalTestAlreadySpentError(input.hypothesisId);
    }
    throw error;
  }
}

/**
 * The only ResearchExperiment a research-originated Backtest belongs to
 * (ResearchExperiment.backtestId is unique). A Backtest created outside the
 * research flow (POST /backtests) has none, so this returns null for it.
 */
async function getResearchExperimentByBacktestId(backtestId: string): Promise<ResearchExperiment | null> {
  const row = await prisma.researchExperiment.findUnique({ where: { backtestId } });
  return row ? mapResearchExperiment(row) : null;
}

/**
 * QUEUED -> RUNNING, atomic (conditional updateMany). Returns null on a miss
 * (already RUNNING, or already terminal), which is not an error: a retried
 * or re-delivered backtest job simply finds it already past QUEUED.
 */
async function markResearchExperimentRunning(id: string): Promise<ResearchExperiment | null> {
  const result = await prisma.researchExperiment.updateMany({
    where: { id, status: "QUEUED" },
    data: { status: "RUNNING" },
  });
  if (result.count === 0) {
    return null;
  }
  const row = await prisma.researchExperiment.findUniqueOrThrow({ where: { id } });
  return mapResearchExperiment(row);
}

/** Journal-event context (instrument/strategy ids) for an experiment's linked Backtest, if any. */
async function experimentEventContext(
  tx: Prisma.TransactionClient,
  backtestId: string | null,
): Promise<{ instrumentId: string | null; strategyId: string | null; strategyVersionId: string | null }> {
  if (!backtestId) {
    return { instrumentId: null, strategyId: null, strategyVersionId: null };
  }
  const backtest = await tx.backtest.findUnique({
    where: { id: backtestId },
    select: { instrumentId: true, strategyVersionId: true, strategyVersion: { select: { strategyId: true } } },
  });
  return {
    instrumentId: backtest?.instrumentId ?? null,
    strategyId: backtest?.strategyVersion.strategyId ?? null,
    strategyVersionId: backtest?.strategyVersionId ?? null,
  };
}

/**
 * QUEUED/RUNNING -> COMPLETED, atomic, with its RESEARCH_EXPERIMENT_COMPLETED
 * journal event written in the same transaction (the markPaperCandidate /
 * closeJournalTrade atomic conditional-updateMany-then-recheck pattern).
 * Returns null on a miss: the experiment is already COMPLETED (a retried
 * job, no duplicate event) or FAILED (terminal; a FAILED experiment is
 * never silently relabeled COMPLETED).
 */
async function markResearchExperimentCompleted(id: string, backtestId: string): Promise<ResearchExperiment | null> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.researchExperiment.updateMany({
      where: { id, status: { in: [...ACTIVE_EXPERIMENT_STATUSES] } },
      data: { status: "COMPLETED", backtestId, completedAt: new Date() },
    });
    if (result.count === 0) {
      return null;
    }

    const row = await tx.researchExperiment.findUniqueOrThrow({ where: { id } });
    const context = await experimentEventContext(tx, row.backtestId);

    await createJournalEvent(
      {
        eventType: "RESEARCH_EXPERIMENT_COMPLETED",
        entityType: "RESEARCH_EXPERIMENT",
        entityId: row.id,
        ...context,
        metadata: { hypothesisId: row.hypothesisId, datasetRole: row.datasetRole, backtestId: row.backtestId },
      },
      tx,
    );

    return mapResearchExperiment(row);
  });
}

/**
 * QUEUED/RUNNING -> FAILED, atomic, with a RESEARCH_EXPERIMENT_FAILED
 * journal event in the same transaction. Returns null on a miss. Crucially,
 * a COMPLETED experiment can never be relabeled FAILED after the fact:
 * doing so would drop it out of the final-test partial unique index's scope
 * (status <> 'FAILED') and allow a "renewed" FINAL_TEST on the same
 * hypothesis, defeating docs/research-methodology.md's "the final test
 * dataset is not renewable" guarantee.
 */
async function markResearchExperimentFailed(id: string, failureReason: string): Promise<ResearchExperiment | null> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.researchExperiment.updateMany({
      where: { id, status: { in: [...ACTIVE_EXPERIMENT_STATUSES] } },
      data: { status: "FAILED", failureReason, completedAt: new Date() },
    });
    if (result.count === 0) {
      return null;
    }

    const row = await tx.researchExperiment.findUniqueOrThrow({ where: { id } });
    const context = await experimentEventContext(tx, row.backtestId);

    await createJournalEvent(
      {
        eventType: "RESEARCH_EXPERIMENT_FAILED",
        entityType: "RESEARCH_EXPERIMENT",
        entityId: row.id,
        ...context,
        metadata: {
          hypothesisId: row.hypothesisId,
          datasetRole: row.datasetRole,
          backtestId: row.backtestId,
          failureReason,
        },
      },
      tx,
    );

    return mapResearchExperiment(row);
  });
}

async function listResearchExperimentsForHypothesis(hypothesisId: string): Promise<ResearchExperiment[]> {
  const rows = await prisma.researchExperiment.findMany({
    where: { hypothesisId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapResearchExperiment);
}

/** Sums today's (UTC) AgentExecution spend, used by ResearchService.assertWithinBudget before enqueueing a new agent job. */
async function getTodayResearchSpend(): Promise<{ tokensUsed: number; costUsd: Decimal }> {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.agentExecution.findMany({
    where: { startedAt: { gte: startOfDayUtc } },
    select: { tokensInput: true, tokensOutput: true, costUsd: true },
  });

  const tokensUsed = rows.reduce((sum, row) => sum + (row.tokensInput ?? 0) + (row.tokensOutput ?? 0), 0);
  const costUsd = rows.reduce(
    (sum, row) => sum.plus(row.costUsd ? new Decimal(row.costUsd.toString()) : 0),
    new Decimal(0),
  );

  return { tokensUsed, costUsd };
}

/**
 * Joins JournalTrade -> Setup -> MarketSnapshot to attach regime/session/
 * VWAP-distance context. A JournalTrade with no setupId (a purely manual
 * entry) or whose Setup has no MarketSnapshot yields context: null; see
 * EnrichedJournalTrade's doc comment in packages/analytics.
 *
 * A CLOSED JournalTrade is guaranteed by closeJournalTrade to have non-null
 * actualEntry/actualExit/quantity/entryTimestamp/exitTimestamp/grossPnl/
 * netPnl (mirrors the same runtime guard in analytics-adapter.ts's
 * getNormalizedJournalTrades, which this function's mapping otherwise
 * duplicates for the enriched, research-facing shape).
 */
async function listEnrichedJournalTradesForResearch(filter: {
  strategyId?: string;
  instrumentId?: string;
  windowStart?: Date;
  windowEnd?: Date;
}): Promise<EnrichedJournalTrade[]> {
  const rows = await prisma.journalTrade.findMany({
    where: {
      status: "CLOSED",
      ...(filter.strategyId ? { strategyId: filter.strategyId } : {}),
      ...(filter.instrumentId ? { instrumentId: filter.instrumentId } : {}),
      ...(filter.windowStart || filter.windowEnd
        ? {
            entryTimestamp: {
              ...(filter.windowStart ? { gte: filter.windowStart } : {}),
              ...(filter.windowEnd ? { lte: filter.windowEnd } : {}),
            },
          }
        : {}),
    },
    include: { setup: { include: { marketSnapshot: true } } },
    orderBy: { entryTimestamp: "asc" },
  });

  return rows.map((row) => {
    const normalized = mapJournalTrade(row);

    if (
      normalized.actualEntry === null ||
      normalized.actualExit === null ||
      normalized.quantity === null ||
      normalized.entryTimestamp === null ||
      normalized.exitTimestamp === null ||
      normalized.grossPnl === null ||
      normalized.netPnl === null
    ) {
      throw new Error(
        `JournalTrade ${normalized.id} has status CLOSED but is missing required fields; data integrity violation`,
      );
    }

    const marketSnapshot = row.setup?.marketSnapshot ? mapMarketSnapshot(row.setup.marketSnapshot) : null;

    return {
      source: "JOURNAL" as const,
      id: normalized.id,
      strategyId: normalized.strategyId,
      strategyVersionId: normalized.strategyVersionId,
      instrumentId: normalized.instrumentId,
      direction: normalized.direction,
      executionMode: normalized.executionMode,
      entryTimestamp: normalized.entryTimestamp,
      exitTimestamp: normalized.exitTimestamp,
      entryPrice: normalized.actualEntry,
      exitPrice: normalized.actualExit,
      quantity: normalized.quantity,
      grossPnl: normalized.grossPnl,
      fees: normalized.actualFees ?? new Decimal(0),
      netPnl: normalized.netPnl,
      riskAmount: normalized.plannedRisk,
      rMultiple: normalized.rMultiple,
      mfe: normalized.mfe,
      mae: normalized.mae,
      slippage: normalized.actualSlippage ?? normalized.estimatedSlippage,
      context: marketSnapshot
        ? {
            session: marketSnapshot.session,
            timeOfDay: marketSnapshot.timeOfDay,
            marketRegime: marketSnapshot.marketRegime,
            vwapDistance: marketSnapshot.vwapDistance,
            volumePercentile: marketSnapshot.volumePercentile,
            atrPercentile: marketSnapshot.atrPercentile,
          }
        : null,
    };
  });
}

export const researchRepository = {
  createAgentExecution,
  markAgentExecutionSucceeded,
  markAgentExecutionFailed,
  getAgentExecution,
  listAgentExecutions,
  createResearchHypothesis,
  getResearchHypothesis,
  listResearchHypotheses,
  assertResearchExperimentPreconditions,
  createResearchExperiment,
  getResearchExperimentByBacktestId,
  markResearchExperimentRunning,
  markResearchExperimentCompleted,
  markResearchExperimentFailed,
  listResearchExperimentsForHypothesis,
  getTodayResearchSpend,
  listEnrichedJournalTradesForResearch,
};
