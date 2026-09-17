import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import {
  EMA_TREND_PULLBACK_V1_DEFAULT_PARAMETERS,
  evaluateEmaTrendPullback,
} from "@trading-copilot/strategy-engine";
import { runBacktest, type BacktestRunInput } from "./engine";
import { calculateBacktestMetrics } from "./metrics";
import { D, makeCandle, makeInstrument, makeStrategyVersion } from "./test-helpers";

/**
 * A deterministic (no PRNG needed) trending-then-pulling-back synthetic
 * series: a linear uptrend with a superimposed sine oscillation, so price
 * repeatedly pulls back toward the fast EMA and then continues the trend —
 * exactly the pattern EMA Trend Pullback is designed to catch. Fully
 * reproducible: same `count` always yields the same candles.
 */
function buildSyntheticTrendingCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let previousClose = 100;
  for (let i = 0; i < count; i += 1) {
    const trend = i * 0.3;
    const oscillation = 5 * Math.sin(i * 0.4);
    const close = 100 + trend + oscillation;
    const open = i === 0 ? close : previousClose;
    const wick = 0.5;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    candles.push(makeCandle(i, open.toFixed(4), high.toFixed(4), low.toFixed(4), close.toFixed(4)));
    previousClose = close;
  }
  return candles;
}

describe("EMA Trend Pullback integration: evaluate -> runBacktest -> metrics", () => {
  it("produces at least one trade with internally consistent metrics", () => {
    const candles = buildSyntheticTrendingCandles(150);
    const parameters = EMA_TREND_PULLBACK_V1_DEFAULT_PARAMETERS;

    const signals = evaluateEmaTrendPullback(candles, parameters);
    expect(signals.length).toBeGreaterThan(0);

    const input: BacktestRunInput = {
      strategyKey: "ema-trend-pullback",
      instrument: makeInstrument(),
      candles,
      strategyVersion: makeStrategyVersion(parameters),
      initialBalance: D(100000),
      riskPercentage: D(1),
      slippageTicks: 1,
    };

    const result = runBacktest(input);
    expect(result.trades.length).toBeGreaterThan(0);

    const metrics = calculateBacktestMetrics(result.trades, input.initialBalance);
    expect(metrics.totalTrades).toBe(result.trades.length);
    expect(metrics.winningTrades + metrics.losingTrades).toBe(metrics.totalTrades);

    const expectedNetProfit = result.trades.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
    expect(metrics.netProfit.toString()).toBe(expectedNetProfit.toString());
  });

  it("is fully deterministic end to end: rebuilding everything from scratch twice gives identical results", () => {
    const parameters = EMA_TREND_PULLBACK_V1_DEFAULT_PARAMETERS;

    function runFullPipeline() {
      const candles = buildSyntheticTrendingCandles(150);
      const signals = evaluateEmaTrendPullback(candles, parameters);
      const input: BacktestRunInput = {
        strategyKey: "ema-trend-pullback",
        instrument: makeInstrument(),
        candles,
        strategyVersion: makeStrategyVersion(parameters),
        initialBalance: D(100000),
        riskPercentage: D(1),
        slippageTicks: 1,
      };
      const result = runBacktest(input);
      const metrics = calculateBacktestMetrics(result.trades, input.initialBalance);
      return { signals, result, metrics };
    }

    const first = runFullPipeline();
    const second = runFullPipeline();

    expect(second.signals).toEqual(first.signals);
    expect(second.result).toEqual(first.result);
    expect(second.metrics).toEqual(first.metrics);
  });
});
