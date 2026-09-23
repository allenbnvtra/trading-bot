import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, JournalTrade, MarketSnapshot, Setup, StrategyWithVersions } from "@/lib/api";

/**
 * Component-level regression guard for the POST_TRADE render route,
 * mirroring `../../setup/[setupId]/page.test.tsx`'s PRE_TRADE guard and
 * complementing the static `route-boundaries.test.ts` in this same
 * directory. The static test proves the source never contains a `new
 * Date(` wall-clock fallback and does reference `exitTimestamp`; this test
 * proves the *running* route actually calls `getCandlesUpToTimestamp` with
 * the real JournalTrade's `exitTimestamp` value - not just any string that
 * happens to look right at the source level.
 *
 * Same Server Component testing approach as the PRE_TRADE test: the page's
 * default export is called directly as a plain async function (JSX only
 * builds element objects, it doesn't invoke RenderClient), so no DOM
 * rendering is needed or attempted here.
 */

const {
  getCandlesUpToTimestamp,
  getInstrument,
  getJournalTrade,
  getMarketSnapshot,
  getSetup,
  getStrategy,
} = vi.hoisted(() => ({
  getCandlesUpToTimestamp: vi.fn(),
  getInstrument: vi.fn(),
  getJournalTrade: vi.fn(),
  getMarketSnapshot: vi.fn(),
  getSetup: vi.fn(),
  getStrategy: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getCandlesUpToTimestamp,
  getInstrument,
  getJournalTrade,
  getMarketSnapshot,
  getSetup,
  getStrategy,
}));

const TRADE_ID = "trade-1";
const SETUP_ID = "setup-1";

// Deliberately distinct from every other timestamp in this fixture set
// (JournalTrade.createdAt/updatedAt/entryTimestamp, MarketSnapshot.timestamp)
// so a bug that reads the wrong field produces a visibly different value in
// the assertion below rather than accidentally matching by coincidence.
const EXIT_TIMESTAMP = "2026-03-12T19:45:00.000Z";
const ENTRY_TIMESTAMP = "2026-03-12T14:05:00.000Z";
const SNAPSHOT_TIMESTAMP = "2026-03-12T14:00:00.000Z";

function buildJournalTrade(overrides: Partial<JournalTrade> = {}): JournalTrade {
  return {
    id: TRADE_ID,
    setupId: SETUP_ID,
    instrumentId: "instrument-1",
    strategyId: "strategy-1",
    strategyVersionId: "strategy-version-1",
    direction: "LONG",
    plannedEntry: "100.00",
    plannedStop: "98.00",
    plannedTarget1: "104.00",
    plannedTarget2: null,
    actualEntry: "100.10",
    actualExit: "104.00",
    entryTimestamp: ENTRY_TIMESTAMP,
    exitTimestamp: EXIT_TIMESTAMP,
    quantity: 1,
    plannedRisk: "100",
    estimatedFees: "2.25",
    actualFees: "2.25",
    estimatedSlippage: "0",
    actualSlippage: "0.10",
    grossPnl: "390",
    netPnl: "387.75",
    rMultiple: "3.9",
    mfe: "410",
    mae: "-20",
    executionMode: "PAPER",
    status: "CLOSED",
    outcome: "WIN",
    entryNotes: null,
    exitNotes: null,
    createdAt: "2026-03-12T14:00:05.000Z",
    updatedAt: EXIT_TIMESTAMP,
    ...overrides,
  };
}

function buildSetup(overrides: Partial<Setup> = {}): Setup {
  return {
    id: SETUP_ID,
    instrumentId: "instrument-1",
    strategyId: "strategy-1",
    strategyVersionId: "strategy-version-1",
    marketSnapshotId: "snapshot-1",
    direction: "LONG",
    source: "TRADINGVIEW",
    plannedEntry: "100.00",
    plannedStop: "98.00",
    plannedTarget1: "104.00",
    plannedTarget2: null,
    status: "READY",
    decisionSummary: null,
    metadata: {},
    createdAt: "2026-03-12T14:00:00.000Z",
    updatedAt: "2026-03-12T14:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    id: "snapshot-1",
    instrumentId: "instrument-1",
    timestamp: SNAPSHOT_TIMESTAMP,
    timeframe: "5m",
    atr: null,
    volume: null,
    vwap: null,
    nearestSupport: null,
    nearestResistance: null,
    session: null,
    marketRegime: null,
    metadata: {},
    createdAt: "2026-03-12T14:00:05.000Z",
    ...overrides,
  };
}

function buildInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: "instrument-1",
    symbol: "ES",
    name: "E-mini S&P 500",
    assetClass: "FUTURES",
    exchange: "CME",
    currency: "USD",
    tickSize: "0.25",
    tickValue: "12.50",
    pointValue: "50",
    commissionPerContract: "2.25",
    timezone: "America/Chicago",
    sessionConfiguration: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildStrategy(overrides: Partial<StrategyWithVersions> = {}): StrategyWithVersions {
  return {
    id: "strategy-1",
    key: "orb",
    name: "Opening Range Breakout",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    versions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getJournalTrade.mockResolvedValue(buildJournalTrade());
  getSetup.mockResolvedValue(buildSetup());
  getMarketSnapshot.mockResolvedValue(buildSnapshot());
  getInstrument.mockResolvedValue(buildInstrument());
  getStrategy.mockResolvedValue(buildStrategy());
  getCandlesUpToTimestamp.mockResolvedValue([
    {
      id: "candle-1",
      instrumentId: "instrument-1",
      timeframe: "5m",
      timestamp: SNAPSHOT_TIMESTAMP,
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "1000",
    },
  ]);
});

describe("POST_TRADE render route cutoff argument", () => {
  it("fetches candles using the JournalTrade's exitTimestamp as the cutoff, not any other timestamp", async () => {
    const { default: RenderTradePage } = await import("./page");

    await RenderTradePage({ params: Promise.resolve({ tradeId: TRADE_ID }) });

    expect(getCandlesUpToTimestamp).toHaveBeenCalledTimes(1);
    expect(getCandlesUpToTimestamp).toHaveBeenCalledWith(
      "instrument-1",
      "5m",
      EXIT_TIMESTAMP,
      150,
    );

    // Guards against a bug that happens to pass the right value for the
    // wrong reason (e.g. hardcoding the fixture's literal string): assert
    // it's genuinely the mocked trade's own `exitTimestamp` field flowing
    // through, not a coincidental match.
    const tradeFromMock = await getJournalTrade.mock.results[0]?.value;
    expect(getCandlesUpToTimestamp).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      tradeFromMock.exitTimestamp,
      expect.any(Number),
    );
  });

  it("does not fall back to entryTimestamp, the MarketSnapshot's timestamp, or a wall-clock value as the cutoff", async () => {
    const { default: RenderTradePage } = await import("./page");

    await RenderTradePage({ params: Promise.resolve({ tradeId: TRADE_ID }) });

    const [, , cutoffArgument] = getCandlesUpToTimestamp.mock.calls[0] ?? [];
    expect(cutoffArgument).not.toBe(ENTRY_TIMESTAMP);
    expect(cutoffArgument).not.toBe(SNAPSHOT_TIMESTAMP);
  });

  it("never fetches candles for a trade that is not CLOSED", async () => {
    getJournalTrade.mockResolvedValue(buildJournalTrade({ status: "OPEN", exitTimestamp: null }));

    const { default: RenderTradePage } = await import("./page");
    await RenderTradePage({ params: Promise.resolve({ tradeId: TRADE_ID }) });

    expect(getCandlesUpToTimestamp).not.toHaveBeenCalled();
  });
});
