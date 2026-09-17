/**
 * Development seed script. Run via `pnpm db:seed` (or `prisma db seed`).
 *
 * Produces:
 *   - one generic Instrument fixture per asset class (FUTURES/FOREX/CRYPTO/STOCK)
 *   - one Strategy + one immutable StrategyVersion (EMA Trend Pullback v1.0.0)
 *   - a deterministic SYNTHETIC (not real) 1h OHLCV candle series for the
 *     FUTURES fixture, imported through src/candle-importer.ts so the
 *     importer gets exercised by the seed itself.
 *
 * Idempotent: safe to re-run. Instrument/Strategy lookups are done by their
 * unique keys before creating, and the candle import is upsert-based, so
 * re-running never creates duplicates or errors. StrategyVersion is
 * strictly append-only (see src/repositories/strategies.ts) — the seed
 * looks up an existing version by (strategyId, version) and skips creating
 * it again rather than ever updating it.
 */
import { Readable } from "node:stream";
import type { AssetClass } from "@trading-copilot/shared-types";
import { prisma } from "../src/client";
import { importCandlesFromStream } from "../src/candle-importer";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — never Math.random(). Same seed always
// produces the same candle series, which is what makes this fixture usable
// as a stable Milestone-1 demo dataset.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface InstrumentFixture {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  tickSize: string;
  tickValue: string;
  pointValue: string;
  commissionPerContract: string;
  timezone: string;
  sessionConfiguration: Record<string, unknown>;
}

// Deliberately generic, clearly-labeled development fixtures — never real
// contract specs (no NQ/ES/EURUSD/BTCUSD-style symbols in the engine).
const INSTRUMENT_FIXTURES: InstrumentFixture[] = [
  {
    symbol: "GENFUT1",
    name: "Generic Index Future",
    assetClass: "FUTURES",
    exchange: "SIM-FUT",
    currency: "USD",
    tickSize: "0.25",
    tickValue: "12.50",
    pointValue: "50",
    commissionPerContract: "2.50",
    timezone: "America/New_York",
    sessionConfiguration: { session: "RTH", openTime: "09:30", closeTime: "16:00" },
  },
  {
    symbol: "GENFX1",
    name: "Generic FX Pair",
    assetClass: "FOREX",
    exchange: "SIM-FX",
    currency: "USD",
    tickSize: "0.0001",
    tickValue: "10",
    pointValue: "100000",
    commissionPerContract: "0",
    timezone: "UTC",
    sessionConfiguration: { session: "24H" },
  },
  {
    symbol: "GENCRYPTO1",
    name: "Generic Crypto Perpetual",
    assetClass: "CRYPTO",
    exchange: "SIM-CRYPTO",
    currency: "USD",
    tickSize: "0.5",
    tickValue: "0.5",
    pointValue: "1",
    commissionPerContract: "0",
    timezone: "UTC",
    sessionConfiguration: { session: "24H" },
  },
  {
    symbol: "GENEQ1",
    name: "Generic Equity",
    assetClass: "STOCK",
    exchange: "SIM-EQ",
    currency: "USD",
    tickSize: "0.01",
    tickValue: "0.01",
    pointValue: "1",
    commissionPerContract: "0.005",
    timezone: "America/New_York",
    sessionConfiguration: { session: "RTH", openTime: "09:30", closeTime: "16:00" },
  },
];

async function findOrCreateInstrument(fixture: InstrumentFixture): Promise<string> {
  const existing = await prisma.instrument.findUnique({
    where: { symbol_exchange: { symbol: fixture.symbol, exchange: fixture.exchange } },
  });
  if (existing) {
    console.log(`  instrument ${fixture.symbol}@${fixture.exchange} already exists (${existing.id})`);
    return existing.id;
  }

  const created = await prisma.instrument.create({
    data: {
      symbol: fixture.symbol,
      name: fixture.name,
      assetClass: fixture.assetClass,
      exchange: fixture.exchange,
      currency: fixture.currency,
      tickSize: fixture.tickSize,
      tickValue: fixture.tickValue,
      pointValue: fixture.pointValue,
      commissionPerContract: fixture.commissionPerContract,
      timezone: fixture.timezone,
      sessionConfiguration: fixture.sessionConfiguration,
    },
  });
  console.log(`  created instrument ${fixture.symbol}@${fixture.exchange} (${created.id})`);
  return created.id;
}

const STRATEGY_KEY = "ema-trend-pullback";
const STRATEGY_VERSION = "1.0.0";

async function findOrCreateStrategy(): Promise<string> {
  const existing = await prisma.strategy.findUnique({ where: { key: STRATEGY_KEY } });
  if (existing) {
    console.log(`  strategy ${STRATEGY_KEY} already exists (${existing.id})`);
    return existing.id;
  }

  const created = await prisma.strategy.create({
    data: {
      key: STRATEGY_KEY,
      name: "EMA Trend Pullback",
      description:
        "Trend-following pullback strategy: enters on a pullback to the fast EMA in the direction of the slow EMA trend, with ATR-based stop and target.",
    },
  });
  console.log(`  created strategy ${STRATEGY_KEY} (${created.id})`);
  return created.id;
}

/**
 * StrategyVersion rows are immutable once created (see
 * src/repositories/strategies.ts). This looks up an existing version and
 * only creates one if it doesn't already exist — it never updates one.
 */
async function findOrCreateStrategyVersion(strategyId: string): Promise<string> {
  const existing = await prisma.strategyVersion.findUnique({
    where: { strategyId_version: { strategyId, version: STRATEGY_VERSION } },
  });
  if (existing) {
    console.log(`  strategy version ${STRATEGY_VERSION} already exists (${existing.id})`);
    return existing.id;
  }

  const created = await prisma.strategyVersion.create({
    data: {
      strategyId,
      version: STRATEGY_VERSION,
      name: "EMA Trend Pullback v1.0.0",
      description: "Initial Milestone-1 backtestable version.",
      parameters: {
        fastEmaPeriod: 20,
        slowEmaPeriod: 50,
        atrPeriod: 14,
        stopAtrMultiplier: 1,
        targetAtrMultiplier: 2,
        allowLong: true,
        allowShort: true,
      },
      status: "BACKTESTING",
    },
  });
  console.log(`  created strategy version ${STRATEGY_VERSION} (${created.id})`);
  return created.id;
}

const CANDLE_SEED = 42;
const CANDLE_COUNT = 850;
const CANDLE_START = new Date("2024-01-01T00:00:00.000Z");

/**
 * Deterministic SYNTHETIC TEST DATA — NOT REAL MARKET DATA. A seeded random
 * walk, not a model of any real instrument's price action. Enough bars
 * (850 hourly) to warm up EMA(50)/ATR(14) and produce several strategy
 * signals for a Milestone-1 demo backtest.
 */
function generateSyntheticCandleCsv(count: number, start: Date, seed: number): string {
  const rand = mulberry32(seed);
  const rows: string[] = ["timestamp,open,high,low,close,volume"];

  let price = 5000;
  let timestamp = start.getTime();
  const hourMs = 60 * 60 * 1000;

  for (let i = 0; i < count; i += 1) {
    const open = price;
    const drift = (rand() - 0.5) * 10; // random-walk step
    let close = open + drift;
    if (close < 1) close = 1; // keep the walk positive

    const wickUp = rand() * 4;
    const wickDown = rand() * 4;
    const high = Math.max(open, close) + wickUp;
    const low = Math.max(0.01, Math.min(open, close) - wickDown);
    const volume = 100 + rand() * 900;

    rows.push(
      [
        new Date(timestamp).toISOString(),
        open.toFixed(2),
        high.toFixed(2),
        low.toFixed(2),
        close.toFixed(2),
        volume.toFixed(2),
      ].join(","),
    );

    price = close;
    timestamp += hourMs;
  }

  return rows.join("\n") + "\n";
}

function readableFromString(text: string): Readable {
  return new Readable({
    read() {
      this.push(text);
      this.push(null);
    },
  });
}

async function seedCandles(instrumentId: string): Promise<void> {
  const csv = generateSyntheticCandleCsv(CANDLE_COUNT, CANDLE_START, CANDLE_SEED);
  const summary = await importCandlesFromStream(prisma, readableFromString(csv), {
    instrumentId,
    timeframe: "1h",
  });
  console.log(
    `  candles: rowsRead=${summary.rowsRead} inserted=${summary.inserted} updated=${summary.updated} rejected=${summary.rejected}`,
  );
  if (summary.errors.length > 0) {
    console.warn("  candle import errors:", summary.errors);
  }
}

async function main(): Promise<void> {
  console.log("Seeding instruments...");
  const instrumentIds: Record<AssetClass, string> = { FUTURES: "", FOREX: "", CRYPTO: "", STOCK: "" };
  for (const fixture of INSTRUMENT_FIXTURES) {
    instrumentIds[fixture.assetClass] = await findOrCreateInstrument(fixture);
  }

  console.log("Seeding strategy...");
  const strategyId = await findOrCreateStrategy();
  await findOrCreateStrategyVersion(strategyId);

  console.log("Seeding SYNTHETIC TEST DATA candles (NOT REAL MARKET DATA) for the futures fixture...");
  await seedCandles(instrumentIds.FUTURES);

  console.log("Seed complete.");
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
