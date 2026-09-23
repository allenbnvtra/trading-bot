import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "./client";
import * as instrumentsRepository from "./repositories/instruments";
import { getCandlesUpToTimestamp } from "./repositories/candles";

/**
 * Proves the anti-look-ahead cutoff boundary of getCandlesUpToTimestamp
 * (packages/database/src/repositories/candles.ts) actually holds at the
 * database level, not merely in a mocked unit test. Requires DATABASE_URL
 * (the project's docker-compose Postgres, `pnpm infra:up`); mirrors the
 * skip gating used by journal.integration.test.ts and
 * webhook-ingestion.integration.test.ts.
 *
 * A fresh, uniquely-symboled Instrument is created per test (rather than
 * reusing the Milestone 1 seeded GENFUT1 instrument) so the
 * (instrumentId, timeframe, timestamp) unique constraint can never collide
 * with another test run or with seeded/other-suite candle data on this
 * shared, non-transactional dev database. This is a
 * SYNTHETIC TEST DATA — NOT REAL MARKET DATA fixture, created only to
 * exercise the query boundary; it is never presented as real market data.
 */
describe.skipIf(!process.env.DATABASE_URL)("getCandlesUpToTimestamp (live Postgres)", () => {
  async function createTestInstrument() {
    return instrumentsRepository.createInstrument({
      symbol: `TEST-CUTOFF-${randomUUID().slice(0, 8)}`,
      name: "SYNTHETIC TEST DATA — NOT REAL MARKET DATA",
      assetClass: "FUTURES",
      exchange: "SIM-FUT",
      currency: "USD",
      tickSize: "0.25",
      tickValue: "12.50",
      pointValue: "50",
      commissionPerContract: "2.50",
      timezone: "UTC",
      sessionConfiguration: {},
    });
  }

  it("includes a candle exactly at the cutoff and excludes one 1ms after it", async () => {
    const instrument = await createTestInstrument();
    const cutoff = new Date("2026-09-18T01:30:00.000Z");

    await prisma.candle.createMany({
      data: [
        {
          instrumentId: instrument.id,
          timeframe: "5m",
          timestamp: cutoff,
          open: "1",
          high: "1",
          low: "1",
          close: "1",
          volume: "1",
        },
        {
          instrumentId: instrument.id,
          timeframe: "5m",
          timestamp: new Date(cutoff.getTime() + 1),
          open: "1",
          high: "1",
          low: "1",
          close: "1",
          volume: "1",
        },
      ],
    });

    const result = await getCandlesUpToTimestamp(instrument.id, "5m", cutoff, 150);

    expect(result).toHaveLength(1);
    expect(result[0]!.timestamp.getTime()).toBe(cutoff.getTime());
  });

  it("includes a candle 1ms before the cutoff alongside one at the cutoff when count does not truncate", async () => {
    // Complementary boundary check: a candle exactly at the cutoff must
    // never be silently dropped by an off-by-one in either direction, and
    // one just inside the window (1ms before cutoff) must not be excluded
    // either. count (150) exceeds the number of eligible candles (2), so
    // no truncation occurs here — that is covered separately below.
    const instrument = await createTestInstrument();
    const cutoff = new Date("2026-09-18T02:00:00.000Z");
    const before = new Date(cutoff.getTime() - 1);

    await prisma.candle.createMany({
      data: [
        {
          instrumentId: instrument.id,
          timeframe: "5m",
          timestamp: before,
          open: "1",
          high: "1",
          low: "1",
          close: "1",
          volume: "1",
        },
        {
          instrumentId: instrument.id,
          timeframe: "5m",
          timestamp: cutoff,
          open: "1",
          high: "1",
          low: "1",
          close: "1",
          volume: "1",
        },
      ],
    });

    const result = await getCandlesUpToTimestamp(instrument.id, "5m", cutoff, 150);

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.timestamp.getTime())).toEqual([before.getTime(), cutoff.getTime()]);
  });

  it("truncates to the most recent `count` candles, keeping the newest and dropping the oldest, in ascending order", async () => {
    // The single most subtle correctness property of this function: it
    // uses `orderBy: desc, take: count` then `.reverse()` (the same idiom
    // as getSurroundingCandles) to keep the NEWEST `count` eligible
    // candles, not the oldest. Seed 5 candles 1 minute apart, all at or
    // before the cutoff, and request only 3 — fewer than the 5 eligible —
    // so truncation actually occurs. If `take` ever cut off the wrong end,
    // this test would return candles 1-3 (the oldest) instead of 3-5 (the
    // newest), silently feeding stale bars into chart rendering.
    const instrument = await createTestInstrument();
    const base = new Date("2026-09-18T03:00:00.000Z");
    const timestamps = [0, 1, 2, 3, 4].map((i) => new Date(base.getTime() + i * 60_000));
    const cutoff = timestamps[4]!;

    await prisma.candle.createMany({
      data: timestamps.map((timestamp) => ({
        instrumentId: instrument.id,
        timeframe: "5m",
        timestamp,
        open: "1",
        high: "1",
        low: "1",
        close: "1",
        volume: "1",
      })),
    });

    const result = await getCandlesUpToTimestamp(instrument.id, "5m", cutoff, 3);

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.timestamp.getTime())).toEqual([
      timestamps[2]!.getTime(),
      timestamps[3]!.getTime(),
      timestamps[4]!.getTime(),
    ]);
  });
});
