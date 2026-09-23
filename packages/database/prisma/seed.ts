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
import { Decimal } from "decimal.js";
import type { AssetClass } from "@trading-copilot/shared-types";
import { prisma } from "../src/client";
import { importCandlesFromStream } from "../src/candle-importer";
import * as marketSnapshotsRepository from "../src/repositories/market-snapshots";
import * as setupsRepository from "../src/repositories/setups";
import * as riskCalculationsRepository from "../src/repositories/risk-calculations";
import * as journalTradesRepository from "../src/repositories/journal-trades";
import * as tradingViewInstrumentMappingsRepository from "../src/repositories/tradingview-instrument-mappings";

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

// ---------------------------------------------------------------------------
// Milestone 2 demo: one complete Setup -> RiskCalculation -> JournalTrade
// lifecycle, for dashboard illustration. Uses the same repository functions
// apps/api will use (not raw Prisma writes), so journal event emission is
// exercised by the seed itself, exactly like the candle importer above.
// Idempotent: guarded by a distinctive metadata tag on the Setup row.
// ---------------------------------------------------------------------------
const DEMO_SEED_TAG = "milestone2-demo-v1";

async function seedDemoJournalLifecycle(
  instrumentId: string,
  strategyId: string,
  strategyVersionId: string,
): Promise<void> {
  const existing = await prisma.setup.findFirst({
    where: { instrumentId, strategyVersionId, source: "MANUAL_TEST" },
  });
  if (existing) {
    console.log(`  demo journal lifecycle already exists (setup ${existing.id})`);
    return;
  }

  const snapshotTimestamp = new Date("2024-02-03T08:00:00.000Z");
  const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
    instrumentId,
    timestamp: snapshotTimestamp,
    timeframe: "1h",
    // Deliberately a handful of representative fields, not every field —
    // MarketSnapshot's remaining fields (support/resistance, VWAP, etc.) are
    // legitimately optional and this demo doesn't need all of them.
    trend1h: "UP",
    trend4h: "UP",
    atr: new Decimal("18.5"),
    volume: new Decimal("640"),
    session: "RTH",
    timeOfDay: "MORNING",
    dayOfWeek: "SATURDAY",
    marketRegime: "TRENDING",
    metadata: { seedTag: DEMO_SEED_TAG },
  });
  console.log(`  created demo MarketSnapshot (${snapshot.id})`);

  const plannedEntry = new Decimal("5100");
  const plannedStop = new Decimal("5088");
  const plannedTarget1 = new Decimal("5124"); // 2R given a 12-point stop

  let setup = await setupsRepository.createSetup({
    instrumentId,
    strategyId,
    strategyVersionId,
    marketSnapshotId: snapshot.id,
    direction: "LONG",
    source: "MANUAL_TEST",
    plannedEntry,
    plannedStop,
    plannedTarget1,
    decisionSummary: "Demo setup for Milestone 2 dashboard illustration (seed data, not a real trade).",
    metadata: { seedTag: DEMO_SEED_TAG },
  });
  console.log(`  created demo Setup (${setup.id}), status=${setup.status}`);

  setup = await setupsRepository.transitionSetupStatus(setup.id, { status: "PREPARE" });
  setup = await setupsRepository.transitionSetupStatus(setup.id, {
    status: "READY",
    decisionSummary: "Pullback confirmed against the 1h/4h uptrend; risk calculated below.",
  });
  console.log(`  transitioned demo Setup WATCH -> PREPARE -> READY (status=${setup.status})`);

  const riskCalculation = await riskCalculationsRepository.createRiskCalculation(setup.id, {
    accountEquity: new Decimal("100000"),
    riskPercentage: new Decimal("1"),
    slippageTicks: 2,
  });
  console.log(
    `  created demo RiskCalculation (${riskCalculation.id}): quantity=${riskCalculation.calculatedQuantity} totalRisk=${riskCalculation.estimatedTotalRisk.toString()}`,
  );

  let trade = await journalTradesRepository.createJournalTrade({
    setupId: setup.id,
    instrumentId,
    strategyId,
    strategyVersionId,
    direction: "LONG",
    plannedEntry,
    plannedStop,
    plannedTarget1,
    plannedRisk: riskCalculation.estimatedTotalRisk,
    executionMode: "PAPER",
    entryNotes: "Paper trade for Milestone 2 dashboard demo.",
  });
  console.log(`  created demo JournalTrade (${trade.id}), status=${trade.status}`);

  trade = await journalTradesRepository.recordJournalTradeEntry(trade.id, {
    actualEntry: new Decimal("5100.25"), // one tick of slippage over the planned entry
    entryTimestamp: new Date("2024-02-03T09:00:00.000Z"),
    quantity: riskCalculation.calculatedQuantity,
    estimatedFees: riskCalculation.estimatedCommission,
    estimatedSlippage: riskCalculation.estimatedSlippage,
  });
  console.log(`  recorded demo JournalTrade entry, status=${trade.status}`);

  trade = await journalTradesRepository.closeJournalTrade(trade.id, {
    actualExit: new Decimal("5123.75"), // one tick of slippage under the planned target
    exitTimestamp: new Date("2024-02-03T15:00:00.000Z"),
    actualFees: riskCalculation.estimatedCommission,
    actualSlippage: riskCalculation.estimatedSlippage,
    // mfe/mae are no longer client-supplied (Milestone 6) — closeJournalTrade
    // now computes them server-side from real Candle rows between entry and
    // exit via calculateExcursions. This demo Setup/candle window doesn't
    // guarantee overlapping seeded candles, so they may come back null here;
    // that's fine for a dashboard demo fixture.
    exitNotes: "Closed near target1 after a clean pullback continuation.",
  });
  console.log(
    `  closed demo JournalTrade (${trade.id}): netPnl=${trade.netPnl?.toString()} rMultiple=${trade.rMultiple?.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Milestone 3 demo: one exchange+symbol -> Instrument mapping, exercising
// tradingview-instrument-mappings.ts's own idempotent check-exists-before-
// create pattern (resolveInstrumentMapping already normalizes case, so this
// also proves the seeded mapping resolves regardless of delivered casing).
// This is what the curl fixtures in apps/api exercise locally.
// ---------------------------------------------------------------------------
const TV_MAPPING_EXCHANGE = "CME";
const TV_MAPPING_SYMBOL = "NQ1!";

async function seedTradingViewInstrumentMapping(instrumentId: string): Promise<void> {
  const existing = await tradingViewInstrumentMappingsRepository.resolveInstrumentMapping(
    TV_MAPPING_EXCHANGE,
    TV_MAPPING_SYMBOL,
  );
  if (existing) {
    console.log(
      `  TradingView instrument mapping ${TV_MAPPING_EXCHANGE}:${TV_MAPPING_SYMBOL} already exists (-> ${existing.id})`,
    );
    return;
  }

  const mapping = await tradingViewInstrumentMappingsRepository.createTradingViewInstrumentMapping({
    exchange: TV_MAPPING_EXCHANGE,
    symbol: TV_MAPPING_SYMBOL,
    instrumentId,
  });
  console.log(
    `  created TradingView instrument mapping ${mapping.exchange}:${mapping.symbol} -> ${instrumentId}`,
  );
}

async function main(): Promise<void> {
  console.log("Seeding instruments...");
  const instrumentIds: Record<AssetClass, string> = { FUTURES: "", FOREX: "", CRYPTO: "", STOCK: "" };
  for (const fixture of INSTRUMENT_FIXTURES) {
    instrumentIds[fixture.assetClass] = await findOrCreateInstrument(fixture);
  }

  console.log("Seeding strategy...");
  const strategyId = await findOrCreateStrategy();
  const strategyVersionId = await findOrCreateStrategyVersion(strategyId);

  console.log("Seeding SYNTHETIC TEST DATA candles (NOT REAL MARKET DATA) for the futures fixture...");
  await seedCandles(instrumentIds.FUTURES);

  console.log("Seeding Milestone 2 demo journal lifecycle...");
  await seedDemoJournalLifecycle(instrumentIds.FUTURES, strategyId, strategyVersionId);

  console.log("Seeding Milestone 3 demo TradingView instrument mapping...");
  await seedTradingViewInstrumentMapping(instrumentIds.FUTURES);

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
