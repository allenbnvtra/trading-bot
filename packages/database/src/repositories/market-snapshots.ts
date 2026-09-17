import type { Prisma } from "@prisma/client";
import type { Decimal } from "decimal.js";
import type { Timeframe } from "@trading-copilot/shared-types";
import type { MarketSnapshot } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapMarketSnapshot } from "../mappers";

/**
 * Immutable once created — no update function exists here, and none should
 * ever be added (see the model-level comment on MarketSnapshot in
 * prisma/schema.prisma). A Setup needing fresher context creates a new row.
 */

export interface CreateMarketSnapshotInput {
  instrumentId: string;
  timestamp: Date;
  timeframe: Timeframe;
  windowCandleCount?: number | null;
  windowStartTimestamp?: Date | null;
  windowEndTimestamp?: Date | null;
  trend1m?: string | null;
  trend5m?: string | null;
  trend15m?: string | null;
  trend1h?: string | null;
  trend4h?: string | null;
  trend1d?: string | null;
  atr?: Decimal | null;
  atrPercentile?: Decimal | null;
  volume?: Decimal | null;
  volumePercentile?: Decimal | null;
  vwap?: Decimal | null;
  vwapDistance?: Decimal | null;
  nearestSupport?: Decimal | null;
  distanceToSupport?: Decimal | null;
  nearestResistance?: Decimal | null;
  distanceToResistance?: Decimal | null;
  session?: string | null;
  timeOfDay?: string | null;
  dayOfWeek?: string | null;
  marketRegime?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createMarketSnapshot(input: CreateMarketSnapshotInput): Promise<MarketSnapshot> {
  const row = await prisma.marketSnapshot.create({
    data: {
      instrumentId: input.instrumentId,
      timestamp: input.timestamp,
      timeframe: input.timeframe,
      windowCandleCount: input.windowCandleCount ?? null,
      windowStartTimestamp: input.windowStartTimestamp ?? null,
      windowEndTimestamp: input.windowEndTimestamp ?? null,
      trend1m: input.trend1m ?? null,
      trend5m: input.trend5m ?? null,
      trend15m: input.trend15m ?? null,
      trend1h: input.trend1h ?? null,
      trend4h: input.trend4h ?? null,
      trend1d: input.trend1d ?? null,
      atr: input.atr?.toString() ?? null,
      atrPercentile: input.atrPercentile?.toString() ?? null,
      volume: input.volume?.toString() ?? null,
      volumePercentile: input.volumePercentile?.toString() ?? null,
      vwap: input.vwap?.toString() ?? null,
      vwapDistance: input.vwapDistance?.toString() ?? null,
      nearestSupport: input.nearestSupport?.toString() ?? null,
      distanceToSupport: input.distanceToSupport?.toString() ?? null,
      nearestResistance: input.nearestResistance?.toString() ?? null,
      distanceToResistance: input.distanceToResistance?.toString() ?? null,
      session: input.session ?? null,
      timeOfDay: input.timeOfDay ?? null,
      dayOfWeek: input.dayOfWeek ?? null,
      marketRegime: input.marketRegime ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
  return mapMarketSnapshot(row);
}

export async function getMarketSnapshot(id: string): Promise<MarketSnapshot | null> {
  const row = await prisma.marketSnapshot.findUnique({ where: { id } });
  return row ? mapMarketSnapshot(row) : null;
}

export interface MarketSnapshotFilters {
  instrumentId?: string;
  timeframe?: Timeframe;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listMarketSnapshots(
  filters: MarketSnapshotFilters = {},
): Promise<MarketSnapshot[]> {
  const rows = await prisma.marketSnapshot.findMany({
    where: {
      instrumentId: filters.instrumentId,
      timeframe: filters.timeframe,
      timestamp:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    },
    orderBy: { timestamp: "desc" },
  });
  return rows.map(mapMarketSnapshot);
}
