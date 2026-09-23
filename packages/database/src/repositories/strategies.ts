import type { Prisma } from "@prisma/client";
import type { StrategyVersionStatus } from "@trading-copilot/shared-types";
import type { Strategy, StrategyVersion } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapStrategy, mapStrategyVersion } from "../mappers";
import { createJournalEvent } from "./journal-events";

export async function createStrategy(input: {
  key: string;
  name: string;
  description: string;
}): Promise<Strategy> {
  const row = await prisma.strategy.create({ data: input });
  return mapStrategy(row);
}

export async function listStrategies(): Promise<Strategy[]> {
  const rows = await prisma.strategy.findMany({ orderBy: { key: "asc" } });
  return rows.map(mapStrategy);
}

/**
 * Milestone 7: looks up the Container Strategy every AI-proposed
 * StrategyDefinition is versioned under (see ResearchService.createExperiment
 * and docs/ai-research.md). Returns null rather than throwing so the caller
 * can decide to create it on a cache miss, mirroring
 * findStrategyVersionByKeyAndVersion's null-on-miss convention below.
 */
export async function getStrategyByKey(key: string): Promise<Strategy | null> {
  const row = await prisma.strategy.findUnique({ where: { key } });
  return row ? mapStrategy(row) : null;
}

export interface StrategyWithVersions extends Strategy {
  versions: StrategyVersion[];
}

export async function getStrategyWithVersions(strategyId: string): Promise<StrategyWithVersions | null> {
  const row = await prisma.strategy.findUnique({
    where: { id: strategyId },
    include: { versions: { orderBy: { createdAt: "asc" } } },
  });
  if (!row) return null;
  const { versions, ...strategyRow } = row;
  return {
    ...mapStrategy(strategyRow),
    versions: versions.map((version) => mapStrategyVersion(version)),
  };
}

export async function getStrategyVersion(id: string): Promise<StrategyVersion | null> {
  const row = await prisma.strategyVersion.findUnique({ where: { id } });
  return row ? mapStrategyVersion(row) : null;
}

export interface StrategyVersionLookup {
  strategy: Strategy;
  strategyVersion: StrategyVersion;
}

/**
 * Milestone 3: resolves a webhook's `strategyKey`/`strategyVersion` strings
 * against real records in one efficient query, rather than the caller doing
 * listStrategies() + a linear scan. Returns null if the strategy key itself
 * doesn't resolve, or if it resolves but has no version matching `version`.
 */
export async function findStrategyVersionByKeyAndVersion(
  strategyKey: string,
  version: string,
): Promise<StrategyVersionLookup | null> {
  const row = await prisma.strategy.findUnique({
    where: { key: strategyKey },
    include: { versions: { where: { version } } },
  });
  if (!row) return null;

  const { versions, ...strategyRow } = row;
  const versionRow = versions[0];
  if (!versionRow) return null;

  return {
    strategy: mapStrategy(strategyRow),
    strategyVersion: mapStrategyVersion(versionRow),
  };
}

/**
 * StrategyVersion rows are immutable once created (see CLAUDE.md and
 * .claude/agents/data-engineer.md). This module deliberately exposes no
 * update/mutate function for `parameters` or `version` — the only way to
 * change a strategy's behavior is to create a new version row via this
 * function.
 */
/**
 * Emits STRATEGY_VERSION_PROPOSED alongside the create, in the same
 * transaction — a new version being introduced into the system is itself a
 * journaled event, regardless of what its initial `status` is. See
 * docs/trade-journal-design.md's "Journal events" table.
 */
export async function createStrategyVersion(input: {
  strategyId: string;
  version: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  status: StrategyVersionStatus;
  /**
   * Milestone 7: set only when this version originates from an AI-proposed
   * ResearchHypothesis (see the model-level comment on StrategyVersion in
   * prisma/schema.prisma). Every hand-authored version omits this and stays
   * null, exactly as before Milestone 7.
   */
  sourceHypothesisId?: string;
}): Promise<StrategyVersion> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.strategyVersion.create({
      data: {
        strategyId: input.strategyId,
        version: input.version,
        name: input.name,
        description: input.description,
        parameters: input.parameters as Prisma.InputJsonValue,
        status: input.status,
        sourceHypothesisId: input.sourceHypothesisId ?? null,
      },
    });

    await createJournalEvent(
      {
        eventType: "STRATEGY_VERSION_PROPOSED",
        entityType: "STRATEGY_VERSION",
        entityId: row.id,
        correlationId: row.id,
        strategyId: row.strategyId,
        strategyVersionId: row.id,
      },
      tx,
    );

    return mapStrategyVersion(row);
  });
}

/**
 * Milestone 7: looks up the StrategyVersion a hypothesis has already had
 * created for it (see ResearchService.createExperiment), so a hypothesis
 * with multiple experiment stages (RESEARCH -> VALIDATION -> FINAL_TEST ->
 * WALK_FORWARD) reuses the exact same StrategyVersion across every stage
 * rather than getting a fresh, redundant row per experiment. A hypothesis
 * can have at most one StrategyVersion in practice (createExperiment only
 * creates one on a cache miss), but this queries the oldest match
 * defensively rather than assuming that invariant holds.
 */
export async function findStrategyVersionBySourceHypothesis(
  hypothesisId: string,
): Promise<StrategyVersion | null> {
  const row = await prisma.strategyVersion.findFirst({
    where: { sourceHypothesisId: hypothesisId },
    orderBy: { createdAt: "asc" },
  });
  return row ? mapStrategyVersion(row) : null;
}

/**
 * Milestone 7: the only way a StrategyVersion's status ever changes after
 * creation (see the "immutable once created" comment on createStrategyVersion
 * above; this changes `status` only, never `parameters`/`version`/etc.).
 * Human-triggered only, via ResearchService.markPaperCandidate: see
 * markPaperCandidateRequestSchema's `confirmedByHuman: true` literal and
 * CLAUDE.md's "AI must never directly modify an approved strategy" rule.
 * This function only ever transitions WALK_FORWARD -> PAPER_CANDIDATE, never
 * touches anything already APPROVED/PAPER_TRADING/live, and is never called
 * except from that one human-gated endpoint.
 *
 * Guarded with an atomic conditional `updateMany` rather than a
 * `findUnique`-then-`update`, exactly like journal-trades.ts's
 * closeJournalTrade (see its comment for the full race-condition
 * explanation): a stale pre-transaction status read cannot be trusted to
 * still hold true by the time an `update` runs, so two concurrent calls
 * could otherwise both believe the version is WALK_FORWARD and both
 * "succeed". `updateMany`'s `where` is re-evaluated against the row's
 * currently-committed state at execution time, so only one concurrent call
 * can ever match. Returns null on a miss (nonexistent id, or status is not
 * currently WALK_FORWARD); the caller (ResearchService) turns that into a
 * 409, never a silent no-op.
 */
export async function markPaperCandidate(id: string): Promise<StrategyVersion | null> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.strategyVersion.updateMany({
      where: { id, status: "WALK_FORWARD" },
      data: { status: "PAPER_CANDIDATE" },
    });
    if (result.count === 0) {
      return null;
    }

    const row = await tx.strategyVersion.findUniqueOrThrow({ where: { id } });

    await createJournalEvent(
      {
        eventType: "STRATEGY_VERSION_STATUS_CHANGED",
        entityType: "STRATEGY_VERSION",
        entityId: row.id,
        correlationId: row.id,
        strategyId: row.strategyId,
        strategyVersionId: row.id,
        metadata: { from: "WALK_FORWARD", to: "PAPER_CANDIDATE" },
      },
      tx,
    );

    return mapStrategyVersion(row);
  });
}
