import type { Timeframe } from "@trading-copilot/shared-types";
import type { Candle } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapCandle } from "../mappers";

export async function getCandles(
  instrumentId: string,
  timeframe: Timeframe,
  startDate: Date,
  endDate: Date,
): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({
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
