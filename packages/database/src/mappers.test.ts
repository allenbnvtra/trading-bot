import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  backtestAssumptionsToJson,
  mapBacktest,
  mapBacktestMetrics,
  mapBacktestTrade,
  mapCandle,
  mapInstrument,
  mapStrategy,
  mapStrategyVersion,
  type PrismaBacktestMetricsRow,
  type PrismaBacktestRow,
  type PrismaBacktestTradeRow,
  type PrismaCandleRow,
  type PrismaInstrumentRow,
  type PrismaStrategyRow,
  type PrismaStrategyVersionRow,
} from "./mappers";

describe("mapInstrument", () => {
  it("converts decimal-string fields to decimal.js Decimal and preserves everything else", () => {
    const row: PrismaInstrumentRow = {
      id: "instrument-1",
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
      sessionConfiguration: { session: "RTH" },
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    };

    const instrument = mapInstrument(row);

    expect(instrument.tickSize).toBeInstanceOf(Decimal);
    expect(instrument.tickSize.toString()).toBe("0.25");
    expect(instrument.tickValue.toString()).toBe("12.5");
    expect(instrument.sessionConfiguration).toEqual({ session: "RTH" });
    expect(instrument.id).toBe("instrument-1");
    expect(instrument.assetClass).toBe("FUTURES");
  });

  it("defaults sessionConfiguration to {} when the JSON column is not an object", () => {
    const row: PrismaInstrumentRow = {
      id: "instrument-2",
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
      sessionConfiguration: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(mapInstrument(row).sessionConfiguration).toEqual({});
  });
});

describe("mapCandle", () => {
  it("maps a candle row, casting timeframe to the Timeframe union", () => {
    const row: PrismaCandleRow = {
      id: "candle-1",
      instrumentId: "instrument-1",
      timeframe: "1h",
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      open: "100.00",
      high: "105.00",
      low: "95.00",
      close: "102.00",
      volume: "1000",
    };

    const candle = mapCandle(row);
    expect(candle.timeframe).toBe("1h");
    expect(candle.high.minus(candle.low).toString()).toBe("10");
  });
});

describe("mapStrategy / mapStrategyVersion", () => {
  it("maps a strategy row", () => {
    const row: PrismaStrategyRow = {
      id: "strategy-1",
      key: "ema-trend-pullback",
      name: "EMA Trend Pullback",
      description: "desc",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    expect(mapStrategy(row)).toEqual({
      id: "strategy-1",
      key: "ema-trend-pullback",
      name: "EMA Trend Pullback",
      description: "desc",
      createdAt: row.createdAt,
    });
  });

  it("maps a strategy version row and preserves the parameters object", () => {
    interface EmaTrendPullbackParams {
      fastEmaPeriod: number;
      slowEmaPeriod: number;
    }

    const row: PrismaStrategyVersionRow = {
      id: "version-1",
      strategyId: "strategy-1",
      version: "1.0.0",
      name: "EMA Trend Pullback v1.0.0",
      description: "desc",
      parameters: { fastEmaPeriod: 20, slowEmaPeriod: 50 },
      status: "BACKTESTING",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    const version = mapStrategyVersion<EmaTrendPullbackParams>(row);
    expect(version.parameters.fastEmaPeriod).toBe(20);
    expect(version.status).toBe("BACKTESTING");
  });
});

describe("mapBacktest / backtestAssumptionsToJson", () => {
  const assumptions = {
    commissionPerContract: "2.50",
    slippageTicks: 1,
    riskPercentage: "1",
    initialBalance: "10000",
  };

  it("round-trips BacktestAssumptions through JSON shaping", () => {
    const json = backtestAssumptionsToJson(assumptions);
    const row: PrismaBacktestRow = {
      id: "backtest-1",
      strategyVersionId: "version-1",
      instrumentId: "instrument-1",
      timeframe: "1h",
      startDate: new Date("2024-01-01T00:00:00.000Z"),
      endDate: new Date("2024-02-01T00:00:00.000Z"),
      status: "QUEUED",
      assumptions: json,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };

    const backtest = mapBacktest(row);
    expect(backtest.assumptions).toEqual(assumptions);
    expect(backtest.timeframe).toBe("1h");
    expect(backtest.startedAt).toBeNull();
  });

  it("throws on a malformed assumptions JSON blob rather than silently defaulting it", () => {
    const row: PrismaBacktestRow = {
      id: "backtest-2",
      strategyVersionId: "version-1",
      instrumentId: "instrument-1",
      timeframe: "1h",
      startDate: new Date(),
      endDate: new Date(),
      status: "QUEUED",
      assumptions: { commissionPerContract: "2.50" }, // missing fields
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      createdAt: new Date(),
    };

    expect(() => mapBacktest(row)).toThrow(/Malformed BacktestAssumptions/);
  });
});

describe("mapBacktestTrade", () => {
  it("converts every money/price field to Decimal", () => {
    const row: PrismaBacktestTradeRow = {
      id: "trade-1",
      backtestId: "backtest-1",
      strategyVersionId: "version-1",
      instrumentId: "instrument-1",
      direction: "LONG",
      signalTimestamp: new Date("2024-01-01T00:00:00.000Z"),
      entryTimestamp: new Date("2024-01-01T01:00:00.000Z"),
      entryPrice: "100.00",
      stopPrice: "98.00",
      targetPrice: "104.00",
      exitTimestamp: new Date("2024-01-01T05:00:00.000Z"),
      exitPrice: "104.00",
      entryReason: "pullback to fast EMA",
      exitReason: "TARGET",
      quantity: 2,
      grossPnl: "8.00",
      fees: "1.00",
      netPnl: "7.00",
      riskAmount: "4.00",
      rMultiple: "2",
      maximumFavorableExcursion: "5.00",
      maximumAdverseExcursion: "1.00",
    };

    const trade = mapBacktestTrade(row);
    expect(trade.entryPrice).toBeInstanceOf(Decimal);
    expect(trade.netPnl.toString()).toBe("7");
    expect(trade.exitReason).toBe("TARGET");
    expect(trade.direction).toBe("LONG");
  });
});

describe("mapBacktestMetrics", () => {
  it("maps profitFactor to null when there are no losing trades", () => {
    const row: PrismaBacktestMetricsRow = {
      id: "metrics-1",
      backtestId: "backtest-1",
      totalTrades: 10,
      winningTrades: 10,
      losingTrades: 0,
      winRate: "1",
      grossProfit: "100",
      grossLoss: "0",
      netProfit: "100",
      profitFactor: null,
      averageTrade: "10",
      averageR: "2",
      largestWin: "20",
      largestLoss: "0",
      averageWin: "10",
      averageLoss: "0",
      maxDrawdown: "0",
      maxDrawdownPercent: "0",
      maximumConsecutiveWins: 10,
      maximumConsecutiveLosses: 0,
      expectancy: "10",
    };

    const metrics = mapBacktestMetrics(row);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.netProfit.toString()).toBe("100");
  });

  it("maps a non-null profitFactor to a Decimal", () => {
    const row: PrismaBacktestMetricsRow = {
      id: "metrics-2",
      backtestId: "backtest-2",
      totalTrades: 10,
      winningTrades: 6,
      losingTrades: 4,
      winRate: "0.6",
      grossProfit: "100",
      grossLoss: "50",
      netProfit: "50",
      profitFactor: "2",
      averageTrade: "5",
      averageR: "1",
      largestWin: "20",
      largestLoss: "-15",
      averageWin: "16.67",
      averageLoss: "12.5",
      maxDrawdown: "10",
      maxDrawdownPercent: "0.1",
      maximumConsecutiveWins: 3,
      maximumConsecutiveLosses: 2,
      expectancy: "5",
    };

    const metrics = mapBacktestMetrics(row);
    expect(metrics.profitFactor).toBeInstanceOf(Decimal);
    expect(metrics.profitFactor?.toString()).toBe("2");
  });
});
