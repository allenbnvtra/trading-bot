import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  backtestAssumptionsToJson,
  mapBacktest,
  mapBacktestMetrics,
  mapBacktestTrade,
  mapCandle,
  mapInstrument,
  mapJournalEvent,
  mapJournalTrade,
  mapMarketSnapshot,
  mapPostTradeAnalysis,
  mapRiskCalculation,
  mapSetup,
  mapStrategy,
  mapStrategyVersion,
  mapTradeScreenshot,
  type PrismaBacktestMetricsRow,
  type PrismaBacktestRow,
  type PrismaBacktestTradeRow,
  type PrismaCandleRow,
  type PrismaInstrumentRow,
  type PrismaJournalEventRow,
  type PrismaJournalTradeRow,
  type PrismaMarketSnapshotRow,
  type PrismaPostTradeAnalysisRow,
  type PrismaRiskCalculationRow,
  type PrismaSetupRow,
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

describe("mapMarketSnapshot", () => {
  it("maps a fully-populated row, converting decimal fields to Decimal", () => {
    const row: PrismaMarketSnapshotRow = {
      id: "snapshot-1",
      instrumentId: "instrument-1",
      timestamp: new Date("2024-02-03T08:00:00.000Z"),
      timeframe: "1h",
      windowCandleCount: 50,
      windowStartTimestamp: new Date("2024-02-01T00:00:00.000Z"),
      windowEndTimestamp: new Date("2024-02-03T08:00:00.000Z"),
      trend1m: null,
      trend5m: null,
      trend15m: null,
      trend1h: "UP",
      trend4h: "UP",
      trend1d: null,
      atr: "18.5",
      atrPercentile: null,
      volume: "640",
      volumePercentile: null,
      vwap: null,
      vwapDistance: null,
      nearestSupport: null,
      distanceToSupport: null,
      nearestResistance: null,
      distanceToResistance: null,
      session: "RTH",
      timeOfDay: "MORNING",
      dayOfWeek: "SATURDAY",
      marketRegime: "TRENDING",
      metadata: { seedTag: "milestone2-demo-v1" },
      createdAt: new Date("2024-02-03T08:00:00.000Z"),
    };

    const snapshot = mapMarketSnapshot(row);
    expect(snapshot.atr).toBeInstanceOf(Decimal);
    expect(snapshot.atr?.toString()).toBe("18.5");
    expect(snapshot.atrPercentile).toBeNull();
    expect(snapshot.metadata).toEqual({ seedTag: "milestone2-demo-v1" });
    expect(snapshot.trend1h).toBe("UP");
  });

  it("defaults metadata to {} when the JSON column is not an object", () => {
    const row: PrismaMarketSnapshotRow = {
      id: "snapshot-2",
      instrumentId: "instrument-1",
      timestamp: new Date(),
      timeframe: "1h",
      windowCandleCount: null,
      windowStartTimestamp: null,
      windowEndTimestamp: null,
      trend1m: null,
      trend5m: null,
      trend15m: null,
      trend1h: null,
      trend4h: null,
      trend1d: null,
      atr: null,
      atrPercentile: null,
      volume: null,
      volumePercentile: null,
      vwap: null,
      vwapDistance: null,
      nearestSupport: null,
      distanceToSupport: null,
      nearestResistance: null,
      distanceToResistance: null,
      session: null,
      timeOfDay: null,
      dayOfWeek: null,
      marketRegime: null,
      metadata: null,
      createdAt: new Date(),
    };

    expect(mapMarketSnapshot(row).metadata).toEqual({});
  });
});

describe("mapSetup", () => {
  it("maps a setup row, converting price fields to Decimal and preserving nullable target2", () => {
    const row: PrismaSetupRow = {
      id: "setup-1",
      instrumentId: "instrument-1",
      strategyId: "strategy-1",
      strategyVersionId: "version-1",
      marketSnapshotId: "snapshot-1",
      direction: "LONG",
      source: "MANUAL_TEST",
      plannedEntry: "5100",
      plannedStop: "5088",
      plannedTarget1: "5124",
      plannedTarget2: null,
      status: "WATCH",
      decisionSummary: null,
      metadata: {},
      createdAt: new Date("2024-02-03T08:00:00.000Z"),
      updatedAt: new Date("2024-02-03T08:00:00.000Z"),
      expiresAt: null,
      sourceWebhookEventId: null,
    };

    const setup = mapSetup(row);
    expect(setup.plannedEntry).toBeInstanceOf(Decimal);
    expect(setup.plannedEntry.toString()).toBe("5100");
    expect(setup.plannedTarget2).toBeNull();
    expect(setup.status).toBe("WATCH");
    expect(setup.sourceWebhookEventId).toBeNull();
  });
});

describe("mapRiskCalculation", () => {
  it("maps every decimal field and preserves calculatedQuantity as a plain number", () => {
    const row: PrismaRiskCalculationRow = {
      id: "risk-1",
      setupId: "setup-1",
      accountEquity: "100000",
      riskPercentage: "1",
      riskBudget: "1000",
      entryPrice: "5100",
      stopPrice: "5088",
      stopDistancePoints: "12",
      stopDistanceTicks: "48",
      pointValue: "50",
      tickValue: "12.50",
      estimatedCommission: "2.50",
      estimatedSlippage: "25",
      riskPerUnit: "627.5",
      calculatedQuantity: 1,
      estimatedTotalRisk: "627.5",
      riskReward: "2",
      createdAt: new Date("2024-02-03T08:00:00.000Z"),
    };

    const riskCalc = mapRiskCalculation(row);
    expect(riskCalc.riskPerUnit).toBeInstanceOf(Decimal);
    expect(riskCalc.riskPerUnit.toString()).toBe("627.5");
    expect(riskCalc.calculatedQuantity).toBe(1);
    expect(typeof riskCalc.calculatedQuantity).toBe("number");
  });
});

describe("mapJournalTrade", () => {
  it("maps a fully-closed trade row", () => {
    const row: PrismaJournalTradeRow = {
      id: "trade-1",
      setupId: "setup-1",
      instrumentId: "instrument-1",
      strategyId: "strategy-1",
      strategyVersionId: "version-1",
      direction: "LONG",
      plannedEntry: "5100",
      plannedStop: "5088",
      plannedTarget1: "5124",
      plannedTarget2: null,
      actualEntry: "5100.25",
      actualExit: "5123.75",
      entryTimestamp: new Date("2024-02-03T09:00:00.000Z"),
      exitTimestamp: new Date("2024-02-03T15:00:00.000Z"),
      quantity: 1,
      plannedRisk: "627.5",
      estimatedFees: "2.50",
      actualFees: "2.50",
      estimatedSlippage: "25",
      actualSlippage: "25",
      grossPnl: "1175",
      netPnl: "1172.5",
      rMultiple: "1.8685259",
      mfe: "30",
      mae: "5",
      executionMode: "PAPER",
      status: "CLOSED",
      entryNotes: null,
      exitNotes: "Closed near target1.",
      createdAt: new Date("2024-02-03T08:00:00.000Z"),
      updatedAt: new Date("2024-02-03T15:00:00.000Z"),
    };

    const trade = mapJournalTrade(row);
    expect(trade.netPnl).toBeInstanceOf(Decimal);
    expect(trade.netPnl?.toString()).toBe("1172.5");
    expect(trade.rMultiple?.toString()).toBe("1.8685259");
    expect(trade.status).toBe("CLOSED");
  });

  it("maps a freshly-planned trade row with every post-entry field null", () => {
    const row: PrismaJournalTradeRow = {
      id: "trade-2",
      setupId: null,
      instrumentId: "instrument-1",
      strategyId: "strategy-1",
      strategyVersionId: "version-1",
      direction: "SHORT",
      plannedEntry: "100",
      plannedStop: "105",
      plannedTarget1: null,
      plannedTarget2: null,
      actualEntry: null,
      actualExit: null,
      entryTimestamp: null,
      exitTimestamp: null,
      quantity: null,
      plannedRisk: null,
      estimatedFees: null,
      actualFees: null,
      estimatedSlippage: null,
      actualSlippage: null,
      grossPnl: null,
      netPnl: null,
      rMultiple: null,
      mfe: null,
      mae: null,
      executionMode: "MANUAL_LIVE",
      status: "PLANNED",
      entryNotes: null,
      exitNotes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const trade = mapJournalTrade(row);
    expect(trade.setupId).toBeNull();
    expect(trade.actualEntry).toBeNull();
    expect(trade.rMultiple).toBeNull();
    expect(trade.status).toBe("PLANNED");
  });
});

describe("mapJournalEvent", () => {
  it("maps an event row, preserving the polymorphic entity reference and metadata", () => {
    const row: PrismaJournalEventRow = {
      id: "event-1",
      eventType: "SETUP_CREATED",
      timestamp: new Date("2024-02-03T08:00:00.000Z"),
      sequence: 1,
      entityType: "SETUP",
      entityId: "setup-1",
      correlationId: "setup-1",
      instrumentId: "instrument-1",
      strategyId: "strategy-1",
      strategyVersionId: "version-1",
      metadata: {},
    };

    const event = mapJournalEvent(row);
    expect(event.eventType).toBe("SETUP_CREATED");
    expect(event.entityType).toBe("SETUP");
    expect(event.correlationId).toBe("setup-1");
    expect(event.metadata).toEqual({});
  });
});

describe("mapPostTradeAnalysis", () => {
  it("maps an analysis row, including contributingFactors/researchHypotheses arrays", () => {
    const row: PrismaPostTradeAnalysisRow = {
      id: "analysis-1",
      tradeId: "trade-1",
      tradeSource: "JOURNAL_TRADE",
      outcome: "WIN",
      primaryCause: null,
      contributingFactors: ["EARLY_ENTRY", "HIGH_VOLATILITY"],
      confidence: "0.75",
      evidence: { note: "test" },
      researchHypotheses: ["consider tighter stop"],
      createdAt: new Date("2024-02-03T08:00:00.000Z"),
    };

    const analysis = mapPostTradeAnalysis(row);
    expect(analysis.confidence).toBeInstanceOf(Decimal);
    expect(analysis.contributingFactors).toEqual(["EARLY_ENTRY", "HIGH_VOLATILITY"]);
    expect(analysis.evidence).toEqual({ note: "test" });
    expect(analysis.outcome).toBe("WIN");
  });
});

describe("mapTradeScreenshot", () => {
  it("maps every field, including nullable ones, without fabricating defaults", () => {
    const row = {
      id: "screenshot-1",
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE" as const,
      status: "READY" as const,
      storageProvider: "LOCAL_DISK",
      storageKey: "setups/setup-1/pre-trade/1.0.0.png",
      mimeType: "image/png",
      width: 1440,
      height: 900,
      marketSnapshotId: "snapshot-1",
      chartConfigVersion: "1.0.0",
      renderedAt: new Date("2026-09-23T00:00:00Z"),
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-09-23T00:00:00Z"),
      updatedAt: new Date("2026-09-23T00:00:00Z"),
    };

    expect(mapTradeScreenshot(row)).toEqual({
      id: "screenshot-1",
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      status: "READY",
      storageProvider: "LOCAL_DISK",
      storageKey: "setups/setup-1/pre-trade/1.0.0.png",
      mimeType: "image/png",
      width: 1440,
      height: 900,
      marketSnapshotId: "snapshot-1",
      chartConfigVersion: "1.0.0",
      renderedAt: new Date("2026-09-23T00:00:00Z"),
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-09-23T00:00:00Z"),
      updatedAt: new Date("2026-09-23T00:00:00Z"),
    });
  });
});
