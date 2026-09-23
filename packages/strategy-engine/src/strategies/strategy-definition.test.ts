import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import { evaluateStrategyDefinition, strategyDefinitionSchema } from "./strategy-definition";

let candleSequence = 0;

// Note: the Candle domain type also requires id/instrumentId/timeframe
// (not part of the original brief snippet); filled in here with fixed
// test-only values so this helper satisfies the type.
function candle(timestamp: string, open: number, high: number, low: number, close: number): Candle {
  candleSequence += 1;
  return {
    id: `candle-${candleSequence}`,
    instrumentId: "instrument-1",
    timeframe: "1m",
    timestamp: new Date(timestamp),
    open: new Decimal(open),
    high: new Decimal(high),
    low: new Decimal(low),
    close: new Decimal(close),
    volume: new Decimal(100),
  };
}

const DEFINITION = strategyDefinitionSchema.parse({
  version: "1.0.0",
  direction: "LONG",
  entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 2, slowPeriod: 3 }],
  atrPeriod: 2,
  stopAtrMultiplier: 1,
  targetAtrMultiplier: 2,
});

describe("evaluateStrategyDefinition", () => {
  it("rejects an unknown rule type at parse time", () => {
    expect(() =>
      strategyDefinitionSchema.parse({
        version: "1.0.0",
        direction: "LONG",
        entryRules: [{ type: "DELETE_ALL_TRADES" }],
        atrPeriod: 2,
        stopAtrMultiplier: 1,
        targetAtrMultiplier: 2,
      }),
    ).toThrow();
  });

  it("is look-ahead-safe: only reads candles[0..i] when deciding about index i", () => {
    const candles = [
      candle("2026-01-01T00:00:00Z", 10, 10, 10, 10),
      candle("2026-01-01T00:01:00Z", 10, 10, 10, 10),
      candle("2026-01-01T00:02:00Z", 10, 10, 10, 12),
      candle("2026-01-01T00:03:00Z", 12, 12, 12, 12),
      candle("2026-01-01T00:04:00Z", 12, 12, 12, 12),
    ];
    const fullSignals = evaluateStrategyDefinition(candles, DEFINITION);
    const prefixSignals = evaluateStrategyDefinition(candles.slice(0, 4), DEFINITION);
    const fullSignalsUpToIndex3 = fullSignals.filter((s) => s.index <= 3);
    expect(prefixSignals).toEqual(fullSignalsUpToIndex3);
  });

  it("produces a LONG signal on a fast-over-slow EMA cross with atrAtSignal populated", () => {
    // high/low are deliberately widened beyond open/close (open==high==low
    // would make every candle's true range 0, which would make ATR 0 and
    // this test's own atrAtSignal assertion meaningless). Widening high/low
    // does not affect EMA_CROSS_ABOVE, which only ever reads closes.
    const candles = [
      candle("2026-01-01T00:00:00Z", 10, 11, 9, 10),
      candle("2026-01-01T00:01:00Z", 10, 11, 8, 9),
      candle("2026-01-01T00:02:00Z", 9, 10, 7, 8),
      candle("2026-01-01T00:03:00Z", 8, 14, 7, 13),
      candle("2026-01-01T00:04:00Z", 13, 14, 12, 13),
    ];
    const signals = evaluateStrategyDefinition(candles, DEFINITION);
    expect(signals.length).toBeGreaterThan(0);
    const signal = signals[0]!;
    expect(signal.direction).toBe("LONG");
    expect(signal.atrAtSignal.greaterThan(0)).toBe(true);
  });
});
