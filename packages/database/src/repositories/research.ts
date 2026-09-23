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
import { FinalTestAlreadySpentError, ResearchStageOrderError } from "../errors";
import { mapAgentExecution, mapJournalTrade, mapMarketSnapshot, mapResearchExperiment, mapResearchHypothesis } from "../mappers";

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

/**
 * Enforces dataset-role stage ordering (RESEARCH -> VALIDATION -> FINAL_TEST
 * -> WALK_FORWARD, each requiring a prior-stage COMPLETED experiment) and
 * relies on the partial unique index from the Task 1 migration for the
 * final-test reuse safeguard, translating its P2002 into a typed
 * FinalTestAlreadySpentError rather than letting a raw Prisma error escape.
 */
async function createResearchExperiment(input: {
  hypothesisId: string;
  datasetRole: ResearchDatasetRole;
  datasetWindowStart: Date;
  datasetWindowEnd: Date;
  backtestId?: string;
}): Promise<ResearchExperiment> {
  const roleIndex = DATASET_ROLE_ORDER.indexOf(input.datasetRole);
  if (roleIndex > 0) {
    const priorRole = DATASET_ROLE_ORDER[roleIndex - 1]!;
    const priorCompleted = await prisma.researchExperiment.findFirst({
      where: { hypothesisId: input.hypothesisId, datasetRole: priorRole, status: "COMPLETED" },
    });
    if (!priorCompleted) {
      throw new ResearchStageOrderError(
        input.hypothesisId,
        input.datasetRole,
        `no COMPLETED ${priorRole} experiment exists yet for this hypothesis`,
      );
    }
  }

  try {
    const row = await prisma.researchExperiment.create({
      data: {
        hypothesisId: input.hypothesisId,
        datasetRole: input.datasetRole,
        datasetWindowStart: input.datasetWindowStart,
        datasetWindowEnd: input.datasetWindowEnd,
        backtestId: input.backtestId ?? null,
        status: "QUEUED",
      },
    });
    return mapResearchExperiment(row);
  } catch (error) {
    if (isUniqueConstraintViolation(error, ["hypothesisId"])) {
      throw new FinalTestAlreadySpentError(input.hypothesisId);
    }
    throw error;
  }
}

async function markResearchExperimentCompleted(id: string, backtestId: string): Promise<ResearchExperiment> {
  const row = await prisma.researchExperiment.update({
    where: { id },
    data: { status: "COMPLETED", backtestId, completedAt: new Date() },
  });
  return mapResearchExperiment(row);
}

async function markResearchExperimentFailed(id: string, failureReason: string): Promise<ResearchExperiment> {
  const row = await prisma.researchExperiment.update({
    where: { id },
    data: { status: "FAILED", failureReason, completedAt: new Date() },
  });
  return mapResearchExperiment(row);
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
  createResearchExperiment,
  markResearchExperimentCompleted,
  markResearchExperimentFailed,
  listResearchExperimentsForHypothesis,
  getTodayResearchSpend,
  listEnrichedJournalTradesForResearch,
};
