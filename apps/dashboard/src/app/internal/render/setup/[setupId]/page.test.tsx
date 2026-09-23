import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Instrument,
  MarketSnapshot,
  RiskCalculation,
  Setup,
  StrategyWithVersions,
} from "@/lib/api";

/**
 * Component-level regression guard, complementing the static
 * route-boundaries.test.ts in this same directory. That test proves the
 * PRE_TRADE route's source can never *reach* journal/trade data. This test
 * proves the route actually *passes the correct cutoff argument* to
 * `getCandlesUpToTimestamp` - the one thing a static source scan cannot
 * verify, since `snapshot.timestamp` and (say) `new Date()` are both
 * perfectly innocent-looking identifiers/expressions at the source level.
 *
 * A future edit that swapped the cutoff source (e.g. to `new Date()`, or to
 * `setup.createdAt`/`setup.updatedAt` instead of the MarketSnapshot's own
 * timestamp) would pass the static guard untouched but must fail here.
 *
 * This route is an `async` Server Component. It cannot be mounted with
 * @testing-library/react's `render()` (Server Components aren't a client
 * render target, and RenderClient's real child, ChartRenderer, throws in
 * jsdom - see ChartRenderer.test.tsx's note on canvas/matchMedia). Instead
 * this test calls the page's default export directly as a plain async
 * function - JSX like `<RenderClient {...props} />` only builds a React
 * element object (via React.createElement) without invoking RenderClient,
 * so the resulting element's `props` can be inspected directly without any
 * DOM rendering. The real assertion of interest, though, is on the mocked
 * `getCandlesUpToTimestamp` call itself, not on the returned element.
 */

const {
  getCandlesUpToTimestamp,
  getInstrument,
  getLatestRiskCalculation,
  getMarketSnapshot,
  getSetup,
  getStrategy,
} = vi.hoisted(() => ({
  getCandlesUpToTimestamp: vi.fn(),
  getInstrument: vi.fn(),
  getLatestRiskCalculation: vi.fn(),
  getMarketSnapshot: vi.fn(),
  getSetup: vi.fn(),
  getStrategy: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getCandlesUpToTimestamp,
  getInstrument,
  getLatestRiskCalculation,
  getMarketSnapshot,
  getSetup,
  getStrategy,
}));

const SETUP_ID = "setup-1";

// Deliberately distinct from every other timestamp in this fixture set
// (Setup.createdAt/updatedAt, RiskCalculation.createdAt) so a bug that reads
// the wrong field would produce a visibly different value in the assertion
// below rather than accidentally matching by coincidence.
const SNAPSHOT_TIMESTAMP = "2026-03-10T14:32:00.000Z";

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
    createdAt: "2026-03-10T14:00:00.000Z",
    updatedAt: "2026-03-10T14:00:00.000Z",
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
    createdAt: "2026-03-10T14:32:05.000Z",
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

function buildRiskCalculation(overrides: Partial<RiskCalculation> = {}): RiskCalculation {
  return {
    id: "risk-1",
    setupId: SETUP_ID,
    accountEquity: "10000",
    riskPercentage: "1",
    riskBudget: "100",
    entryPrice: "100.00",
    stopPrice: "98.00",
    stopDistancePoints: "2",
    stopDistanceTicks: "8",
    pointValue: "50",
    tickValue: "12.50",
    estimatedCommission: "2.25",
    estimatedSlippage: "0",
    riskPerUnit: "100",
    calculatedQuantity: 1,
    estimatedTotalRisk: "100",
    riskReward: "2",
    createdAt: "2026-03-10T14:32:10.000Z",
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
  getSetup.mockResolvedValue(buildSetup());
  getMarketSnapshot.mockResolvedValue(buildSnapshot());
  getInstrument.mockResolvedValue(buildInstrument());
  getLatestRiskCalculation.mockResolvedValue(buildRiskCalculation());
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

describe("PRE_TRADE render route cutoff argument", () => {
  it("fetches candles using the Setup's MarketSnapshot.timestamp as the cutoff, not any other timestamp", async () => {
    const { default: RenderSetupPage } = await import("./page");

    await RenderSetupPage({ params: Promise.resolve({ setupId: SETUP_ID }) });

    expect(getCandlesUpToTimestamp).toHaveBeenCalledTimes(1);
    expect(getCandlesUpToTimestamp).toHaveBeenCalledWith(
      "instrument-1",
      "5m",
      SNAPSHOT_TIMESTAMP,
      150,
    );

    // Guards against a bug that happens to pass the right value for the
    // wrong reason (e.g. hardcoding the fixture's literal string): assert
    // it's genuinely the mocked snapshot's own `timestamp` field flowing
    // through, not a coincidental match.
    const snapshotFromMock = await getMarketSnapshot.mock.results[0]?.value;
    expect(getCandlesUpToTimestamp).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      snapshotFromMock.timestamp,
      expect.any(Number),
    );
  });

  it("does not fall back to a wall-clock or setup-record timestamp as the cutoff", async () => {
    const { default: RenderSetupPage } = await import("./page");

    await RenderSetupPage({ params: Promise.resolve({ setupId: SETUP_ID }) });

    const [, , cutoffArgument] = getCandlesUpToTimestamp.mock.calls[0] ?? [];
    // The Setup fixture's own createdAt/updatedAt are deliberately different
    // from the MarketSnapshot's timestamp above - a regression that read
    // the wrong field would show up here.
    expect(cutoffArgument).not.toBe(buildSetup().createdAt);
    expect(cutoffArgument).not.toBe(buildSetup().updatedAt);
  });
});
