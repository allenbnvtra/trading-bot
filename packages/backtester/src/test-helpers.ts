import Decimal from "decimal.js";
import type { Candle, Instrument, StrategyVersion } from "@trading-copilot/trading-domain";
import type { EmaTrendPullbackParameters } from "@trading-copilot/strategy-engine";

/** Test-only fixture builders shared across backtester unit/integration tests. */

export const D = (value: string | number) => new Decimal(value);

export function makeInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: "instrument-1",
    symbol: "TEST",
    name: "Test Instrument",
    assetClass: "FUTURES",
    exchange: "TEST",
    currency: "USD",
    tickSize: D("0.25"),
    tickValue: D("12.5"),
    pointValue: D(50),
    commissionPerContract: D("2.5"),
    timezone: "UTC",
    sessionConfiguration: {},
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

export function makeStrategyVersion(
  parameters: EmaTrendPullbackParameters,
  overrides: Partial<StrategyVersion<EmaTrendPullbackParameters>> = {},
): StrategyVersion<EmaTrendPullbackParameters> {
  return {
    id: "strategy-version-1",
    strategyId: "strategy-1",
    version: "1.0.0",
    name: "EMA Trend Pullback",
    description: "Milestone 1 example strategy — not tuned for profitability.",
    parameters,
    status: "BACKTESTING",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    sourceHypothesisId: null,
    ...overrides,
  };
}

export function makeCandle(
  index: number,
  open: number | string,
  high: number | string,
  low: number | string,
  close: number | string,
): Candle {
  return {
    id: `candle-${index}`,
    instrumentId: "instrument-1",
    timeframe: "1d",
    timestamp: new Date(Date.UTC(2024, 0, index + 1)),
    open: D(open),
    high: D(high),
    low: D(low),
    close: D(close),
    volume: D(1000),
  };
}

export const BASE_PARAMETERS: EmaTrendPullbackParameters = {
  fastEmaPeriod: 2,
  slowEmaPeriod: 3,
  atrPeriod: 2,
  stopAtrMultiplier: 1,
  targetAtrMultiplier: 2,
  allowLong: true,
  allowShort: true,
};

/**
 * Base 5-candle flat-OHLC series (open=high=low=close) that produces exactly
 * one LONG signal at index 4, under BASE_PARAMETERS. Hand-verified in
 * packages/strategy-engine/src/strategies/ema-trend-pullback.test.ts:
 *   EMA(2): seed@1=101, idx2=103, idx3=103, idx4=106.333...
 *   EMA(3): seed@2=102, idx3=102.5, idx4=105.25
 * ATR(2) over this same flat series (high=low=close):
 *   TR0=0, TR1=2, TR2=2, TR3=1, TR4=5
 *   seed@1=1, atr2=1.5, atr3=1.25, atr4=3.125
 * So at the signal candle (index 4): atrAtSignal = 3.125.
 */
export const UPTREND_SIGNAL_CLOSES = [100, 102, 104, 103, 108];

export function buildBaseUptrendCandles(): Candle[] {
  return UPTREND_SIGNAL_CLOSES.map((close, i) => makeCandle(i, close, close, close, close));
}
