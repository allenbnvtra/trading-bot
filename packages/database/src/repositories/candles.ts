import type { Prisma } from "@prisma/client";
import type { Timeframe } from "@trading-copilot/shared-types";
import type { Candle } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapCandle } from "../mappers";

/**
 * Any Prisma client-shaped object that supports `.candle.findMany` — the
 * top-level `prisma` singleton or a `$transaction` callback's `tx` argument.
 * Lets a caller (e.g. closeJournalTrade in journal-trades.ts) read candles
 * inside the same transaction as the state change that depends on them,
 * rather than reading through the module-level singleton and breaking that
 * transaction's isolation boundary. Mirrors journal-events.ts's own
 * `PrismaClientOrTx` pattern (same shape/role, different table).
 */
export type CandlePrismaClientOrTx = Pick<Prisma.TransactionClient, "candle">;

export async function getCandles(
  instrumentId: string,
  timeframe: Timeframe,
  startDate: Date,
  endDate: Date,
  client: CandlePrismaClientOrTx = prisma,
): Promise<Candle[]> {
  const rows = await client.candle.findMany({
    where: {
      instrumentId,
      timeframe,
      timestamp: { gte: startDate, lte: endDate },
    },
    orderBy: { timestamp: "asc" },
  });
  return rows.map(mapCandle);
}

/**
 * Candles immediately around a given timestamp, for trade-detail views
 * (e.g. "show me the chart around this trade's entry"). `countBefore` and
 * `countAfter` are candle counts, not a time window. The candle exactly at
 * `timestamp`, if one exists, is included in the "after" side.
 */
export async function getSurroundingCandles(
  instrumentId: string,
  timeframe: Timeframe,
  timestamp: Date,
  countBefore: number,
  countAfter: number,
): Promise<Candle[]> {
  const [before, atOrAfter] = await Promise.all([
    prisma.candle.findMany({
      where: { instrumentId, timeframe, timestamp: { lt: timestamp } },
      orderBy: { timestamp: "desc" },
      take: countBefore,
    }),
    prisma.candle.findMany({
      where: { instrumentId, timeframe, timestamp: { gte: timestamp } },
      orderBy: { timestamp: "asc" },
      take: countAfter + 1,
    }),
  ]);

  const merged = [...before].reverse().concat(atOrAfter);
  return merged.map(mapCandle);
}

/**
 * The anti-look-ahead-safe candle query for chart rendering
 * (docs/screenshot-design.md). `cutoffTimestamp` must be an authoritative
 * decision-time timestamp — MarketSnapshot.timestamp for a PRE_TRADE
 * render, JournalTrade.exitTimestamp for POST_TRADE — never `new Date()`.
 * The `timestamp: { lte: cutoffTimestamp }` clause is enforced by
 * PostgreSQL itself, not filtered out of a larger result set in
 * application code: a future candle is never even fetched, let alone
 * rendered and merely hidden. `count` candles ending at or before the
 * cutoff are returned oldest-first (matching getCandles' existing
 * convention), so a candle exactly at the cutoff is included and a candle
 * even 1ms after it is excluded.
 */
export async function getCandlesUpToTimestamp(
  instrumentId: string,
  timeframe: Timeframe,
  cutoffTimestamp: Date,
  count: number,
): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({
    where: { instrumentId, timeframe, timestamp: { lte: cutoffTimestamp } },
    orderBy: { timestamp: "desc" },
    take: count,
  });
  return rows.reverse().map(mapCandle);
}
