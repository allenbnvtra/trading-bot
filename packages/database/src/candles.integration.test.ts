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

  it("excludes a candle 1ms before the cutoff only when count truncates it — sanity check that lte is inclusive, not exclusive, at the boundary itself", async () => {
    // Complementary boundary check: a candle exactly at the cutoff must
    // never be silently dropped by an off-by-one in either direction.
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
});
