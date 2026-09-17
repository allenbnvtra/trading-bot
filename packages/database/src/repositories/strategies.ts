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
