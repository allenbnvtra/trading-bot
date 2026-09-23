import Decimal from "decimal.js";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backtest, Instrument, StrategyVersion } from "@trading-copilot/trading-domain";
import { BacktestRunProcessor } from "./backtest-run.processor";
import type { BacktestRunJobPayload } from "./backtest-run.constants";

const {
  backtestsRepository,
  instrumentsRepository,
  strategiesRepository,
  candlesRepository,
  runBacktest,
  calculateBacktestMetrics,
} = vi.hoisted(() => ({
  backtestsRepository: {
    markBacktestRunning: vi.fn(),
    getBacktest: vi.fn(),
    markBacktestFailed: vi.fn(),
    markBacktestCompleted: vi.fn(),
    replaceBacktestTrades: vi.fn(),
    upsertBacktestMetrics: vi.fn(),
  },
  instrumentsRepository: { getInstrument: vi.fn() },
  strategiesRepository: { getStrategyVersion: vi.fn(), getStrategyWithVersions: vi.fn() },
  candlesRepository: { getCandles: vi.fn() },
  runBacktest: vi.fn(),
  calculateBacktestMetrics: vi.fn(),
}));

vi.mock("@trading-copilot/database", () => ({
  backtestsRepository,
  instrumentsRepository,
  strategiesRepository,
  candlesRepository,
}));

vi.mock("@trading-copilot/backtester", () => ({
  runBacktest,
  calculateBacktestMetrics,
}));

function makeBacktest(): Backtest {
  return {
    id: "backtest-1",
    strategyVersionId: "strategy-version-1",
    instrumentId: "instrument-1",
    timeframe: "1h",
    startDate: new Date("2024-01-01T00:00:00.000Z"),
    endDate: new Date("2024-02-01T00:00:00.000Z"),
    status: "QUEUED",
    assumptions: {
      commissionPerContract: "2.5",
      slippageTicks: 1,
      riskPercentage: "1",
      initialBalance: "10000",
    },
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    createdAt: new Date(),
  };
}

function makeInstrument(): Instrument {
  return {
    id: "instrument-1",
    symbol: "GENFUT1",
    name: "Generic Future",
    assetClass: "FUTURES",
    exchange: "SIM-FUT",
    currency: "USD",
    tickSize: new Decimal("0.25"),
    tickValue: new Decimal("12.5"),
    pointValue: new Decimal("50"),
    commissionPerContract: new Decimal("2.5"),
    timezone: "UTC",
    sessionConfiguration: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeStrategyVersion(): StrategyVersion {
  return {
    id: "strategy-version-1",
    strategyId: "strategy-1",
    version: "1.0.0",
    name: "EMA Trend Pullback",
    description: "",
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
    createdAt: new Date(),
    sourceHypothesisId: null,
  };
}

function makeJob(backtestId: string): Job<BacktestRunJobPayload> {
  return { data: { backtestId } } as Job<BacktestRunJobPayload>;
}

describe("BacktestRunProcessor", () => {
  let processor: BacktestRunProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new BacktestRunProcessor();
  });

  it("runs the full happy path: running -> compute -> persist -> completed", async () => {
    const backtest = makeBacktest();
    const instrument = makeInstrument();
    const strategyVersion = makeStrategyVersion();
    const candles = [{ id: "candle-1" }];
    const trades = [{ netPnl: new Decimal(100), rMultiple: new Decimal(1) }];
    const metrics = { totalTrades: 1 };

    backtestsRepository.markBacktestRunning.mockResolvedValue(backtest);
    backtestsRepository.getBacktest.mockResolvedValue(backtest);
    instrumentsRepository.getInstrument.mockResolvedValue(instrument);
    strategiesRepository.getStrategyVersion.mockResolvedValue(strategyVersion);
    strategiesRepository.getStrategyWithVersions.mockResolvedValue({
      id: "strategy-1",
      key: "ema-trend-pullback",
      name: "EMA Trend Pullback",
      description: "",
      createdAt: new Date(),
      versions: [strategyVersion],
    });
    candlesRepository.getCandles.mockResolvedValue(candles);
    runBacktest.mockReturnValue({ trades, skippedSignalCount: 0 });
    calculateBacktestMetrics.mockReturnValue(metrics);

    await processor.process(makeJob(backtest.id));

    expect(backtestsRepository.markBacktestRunning).toHaveBeenCalledWith(backtest.id);
    expect(candlesRepository.getCandles).toHaveBeenCalledWith(
      backtest.instrumentId,
      backtest.timeframe,
      backtest.startDate,
      backtest.endDate,
    );
    expect(runBacktest).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyKey: "ema-trend-pullback",
        instrument,
        candles,
        slippageTicks: 1,
      }),
    );
    expect(backtestsRepository.replaceBacktestTrades).toHaveBeenCalledWith(backtest.id, trades);
    expect(backtestsRepository.upsertBacktestMetrics).toHaveBeenCalledWith(backtest.id, metrics);
    expect(backtestsRepository.markBacktestCompleted).toHaveBeenCalledWith(backtest.id);
    expect(backtestsRepository.markBacktestFailed).not.toHaveBeenCalled();
  });

  it("marks the backtest FAILED with the error message and rethrows when the instrument is missing", async () => {
    const backtest = makeBacktest();
    backtestsRepository.markBacktestRunning.mockResolvedValue(backtest);
    backtestsRepository.getBacktest.mockResolvedValue(backtest);
    instrumentsRepository.getInstrument.mockResolvedValue(null);
    strategiesRepository.getStrategyVersion.mockResolvedValue(makeStrategyVersion());

    await expect(processor.process(makeJob(backtest.id))).rejects.toThrow(
      `Instrument ${backtest.instrumentId} not found`,
    );

    expect(backtestsRepository.markBacktestFailed).toHaveBeenCalledWith(
      backtest.id,
      `Instrument ${backtest.instrumentId} not found`,
    );
    expect(backtestsRepository.replaceBacktestTrades).not.toHaveBeenCalled();
    expect(backtestsRepository.markBacktestCompleted).not.toHaveBeenCalled();
  });

  it("fails clearly when the strategy key is not in STRATEGY_REGISTRY", async () => {
    const backtest = makeBacktest();
    const instrument = makeInstrument();
    const strategyVersion = makeStrategyVersion();

    backtestsRepository.markBacktestRunning.mockResolvedValue(backtest);
    backtestsRepository.getBacktest.mockResolvedValue(backtest);
    instrumentsRepository.getInstrument.mockResolvedValue(instrument);
    strategiesRepository.getStrategyVersion.mockResolvedValue(strategyVersion);
    strategiesRepository.getStrategyWithVersions.mockResolvedValue({
      id: "strategy-1",
      key: "not-a-real-strategy",
      name: "Unknown",
      description: "",
      createdAt: new Date(),
      versions: [strategyVersion],
    });

    await expect(processor.process(makeJob(backtest.id))).rejects.toThrow(/not a known StrategyKey/);
    expect(backtestsRepository.markBacktestFailed).toHaveBeenCalledWith(
      backtest.id,
      expect.stringContaining("not-a-real-strategy"),
    );
  });
});
