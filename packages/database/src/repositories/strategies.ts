import type { Prisma } from "@prisma/client";
import type { StrategyVersionStatus } from "@trading-copilot/shared-types";
import type { Strategy, StrategyVersion } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapStrategy, mapStrategyVersion } from "../mappers";

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

/**
 * StrategyVersion rows are immutable once created (see CLAUDE.md and
 * .claude/agents/data-engineer.md). This module deliberately exposes no
 * update/mutate function for `parameters` or `version` — the only way to
 * change a strategy's behavior is to create a new version row via this
 * function.
 */
export async function createStrategyVersion(input: {
  strategyId: string;
  version: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  status: StrategyVersionStatus;
}): Promise<StrategyVersion> {
  const row = await prisma.strategyVersion.create({
    data: {
      strategyId: input.strategyId,
      version: input.version,
      name: input.name,
      description: input.description,
      parameters: input.parameters as Prisma.InputJsonValue,
      status: input.status,
    },
  });
  return mapStrategyVersion(row);
}
