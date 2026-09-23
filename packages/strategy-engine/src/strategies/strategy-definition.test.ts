import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import {
  evaluateStrategyDefinition,
  strategyDefinitionSchema,
  STRATEGY_DEFINITION_BOUNDS,
  type EntryRule,
} from "./strategy-definition";

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

/**
 * Builds a 1-minute candle series from closes with open = close,
 * high = close + 1, low = close - 1, so every candle's true range is at
 * least 2 and ATR is never 0.
 */
function widenedCandles(closes: number[]): Candle[] {
  return closes.map((close, i) =>
    candle(
      new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      close,
      close + 1,
      close - 1,
      close,
    ),
  );
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

  /**
   * Prefix-invariance proof of look-ahead safety, one per rule type. Each
   * fixture was verified by actually running evaluateStrategyDefinition
   * (not by eyeballing), and each case first asserts that at least one
   * signal fires at or before the cut index, so a fixture that produces
   * zero signals (which would make the invariance check compare [] to []
   * and pass vacuously) fails loudly instead.
   *
   * Every fixture uses high = close + 1 and low = close - 1 so ATR(2) is
   * nonzero, and every fixture's first five candles are the same shape, so
   * ATR(2) at index 4 is 4.125 in all four cases:
   *   TR = [2, 2, 3, 2, 6]; seed@1 = 2, idx2 = 2.5, idx3 = 2.25, idx4 = 4.125
   *
   * Hand derivation for the EMA_CROSS_ABOVE fixture (closes 10, 11, 9, 8, 13):
   *   EMA(2): seed@1 = 10.5, idx2 = 9.5, idx3 = 8.5, idx4 = 11.5
   *   EMA(3): seed@2 = 10, idx3 = 9, idx4 = 11
   *   At idx4: fastPrev 8.5 <= slowPrev 9 and fastNow 11.5 > slowNow 11, so
   *   exactly one cross fires, at index 4.
   * EMA_CROSS_BELOW uses the mirror image (closes 10, 9, 11, 12, 7).
   * CLOSE_ABOVE_EMA(3) on 10, 11, 9, 8, 13: EMA(3) idx4 = 11 < close 13, so
   * it fires at index 4 (idx2: 9 < 10 and idx3: 8 < 9 do not fire).
   *
   * Each case also builds a "mutated" series whose candles AFTER the cut
   * have deliberately different, signal-flipping values. The test asserts
   * the mutation really does change the post-cut signals (otherwise the
   * mutation would prove nothing) while every signal at or before the cut,
   * including its atrAtSignal and closeAtSignal, stays identical.
   */
  const CUT_INDEX = 4;

  const lookAheadCases: Array<{
    name: string;
    rule: EntryRule;
    direction: "LONG" | "SHORT";
    closes: number[];
    mutatedCloses: number[];
    expectedFullIndexes: number[];
    expectedMutatedIndexes: number[];
  }> = [
    {
      name: "EMA_CROSS_ABOVE",
      rule: { type: "EMA_CROSS_ABOVE", fastPeriod: 2, slowPeriod: 3 },
      direction: "LONG",
      closes: [10, 11, 9, 8, 13, 13, 13, 13],
      mutatedCloses: [10, 11, 9, 8, 13, 2, 1, 30],
      expectedFullIndexes: [4],
      expectedMutatedIndexes: [4, 7],
    },
    {
      name: "EMA_CROSS_BELOW",
      rule: { type: "EMA_CROSS_BELOW", fastPeriod: 2, slowPeriod: 3 },
      direction: "SHORT",
      closes: [10, 9, 11, 12, 7, 7, 7, 7],
      mutatedCloses: [10, 9, 11, 12, 7, 18, 19, 1],
      expectedFullIndexes: [4],
      expectedMutatedIndexes: [4, 7],
    },
    {
      name: "CLOSE_ABOVE_EMA",
      rule: { type: "CLOSE_ABOVE_EMA", period: 3 },
      direction: "LONG",
      closes: [10, 11, 9, 8, 13, 13, 13, 13],
      mutatedCloses: [10, 11, 9, 8, 13, 2, 1, 30],
      expectedFullIndexes: [4, 5, 6, 7],
      expectedMutatedIndexes: [4, 7],
    },
    {
      name: "CLOSE_BELOW_EMA",
      rule: { type: "CLOSE_BELOW_EMA", period: 3 },
      direction: "SHORT",
      closes: [10, 9, 11, 12, 7, 7, 7, 7],
      mutatedCloses: [10, 9, 11, 12, 7, 18, 19, 1],
      expectedFullIndexes: [4, 5, 6, 7],
      expectedMutatedIndexes: [4, 7],
    },
  ];

  it.each(lookAheadCases)(
    "is look-ahead-safe for $name: signals at or before the cut ignore every later candle",
    ({ rule, direction, closes, mutatedCloses, expectedFullIndexes, expectedMutatedIndexes }) => {
      const definition = strategyDefinitionSchema.parse({
        version: "1.0.0",
        direction,
        entryRules: [rule],
        atrPeriod: 2,
        stopAtrMultiplier: 1,
        targetAtrMultiplier: 2,
      });
      const candles = widenedCandles(closes);
      const mutatedCandles = widenedCandles(mutatedCloses);

      const fullSignals = evaluateStrategyDefinition(candles, definition);
      const fullUpToCut = fullSignals.filter((s) => s.index <= CUT_INDEX);

      // Non-vacuity guards: the fixture must actually produce signals, and
      // at least one of them must sit at or before the cut.
      expect(fullSignals.length).toBeGreaterThan(0);
      expect(fullUpToCut.length).toBeGreaterThan(0);
      expect(fullSignals.map((s) => s.index)).toEqual(expectedFullIndexes);
      expect(fullUpToCut[0]!.atrAtSignal.toString()).toBe("4.125");

      // 1. Truncation: evaluating only candles[0..CUT_INDEX] yields exactly
      //    the full run's signals up to the cut.
      const prefixSignals = evaluateStrategyDefinition(
        candles.slice(0, CUT_INDEX + 1),
        definition,
      );
      expect(prefixSignals).toEqual(fullUpToCut);

      // 2. Mutation after the cut: the tail really does flip later signals,
      //    yet nothing at or before the cut changes.
      const mutatedSignals = evaluateStrategyDefinition(mutatedCandles, definition);
      expect(mutatedSignals.map((s) => s.index)).toEqual(expectedMutatedIndexes);
      expect(mutatedSignals.map((s) => s.index)).not.toEqual(fullSignals.map((s) => s.index));
      expect(mutatedSignals.filter((s) => s.index <= CUT_INDEX)).toEqual(fullUpToCut);
    },
  );

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

describe("strategyDefinitionSchema numeric bounds (parameter-mining guard)", () => {
  const VALID = {
    version: "1.0.0",
    direction: "LONG",
    entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 20, slowPeriod: 50 }],
    atrPeriod: 14,
    stopAtrMultiplier: 1,
    targetAtrMultiplier: 2,
  } as const;

  it("exposes the documented bounds", () => {
    expect(STRATEGY_DEFINITION_BOUNDS).toEqual({
      minAtrMultiplier: 0.25,
      maxAtrMultiplier: 10,
      minPeriod: 1,
      maxPeriod: 500,
    });
  });

  it("accepts a realistic in-bounds definition (matches the mock provider's proposal shape)", () => {
    expect(strategyDefinitionSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ["stopAtrMultiplier", 0.25],
    ["stopAtrMultiplier", 10],
    ["targetAtrMultiplier", 0.25],
    ["targetAtrMultiplier", 10],
    ["atrPeriod", 1],
    ["atrPeriod", 500],
  ] as const)("accepts %s at its inclusive bound %s", (field, value) => {
    expect(strategyDefinitionSchema.safeParse({ ...VALID, [field]: value }).success).toBe(true);
  });

  it.each([
    ["stopAtrMultiplier", 0.001],
    ["stopAtrMultiplier", 0.2499],
    ["stopAtrMultiplier", 10.01],
    ["stopAtrMultiplier", 0],
    ["stopAtrMultiplier", -1],
    ["stopAtrMultiplier", Number.POSITIVE_INFINITY],
    ["stopAtrMultiplier", Number.NaN],
    ["targetAtrMultiplier", 0.001],
    ["targetAtrMultiplier", 10.01],
    ["targetAtrMultiplier", 1000],
    ["atrPeriod", 0],
    ["atrPeriod", 501],
    ["atrPeriod", 14.5],
  ] as const)("rejects %s = %s", (field, value) => {
    expect(strategyDefinitionSchema.safeParse({ ...VALID, [field]: value }).success).toBe(false);
  });

  it.each([
    { type: "EMA_CROSS_ABOVE", fastPeriod: 501, slowPeriod: 50 },
    { type: "EMA_CROSS_ABOVE", fastPeriod: 20, slowPeriod: 501 },
    { type: "EMA_CROSS_BELOW", fastPeriod: 0, slowPeriod: 50 },
    { type: "EMA_CROSS_BELOW", fastPeriod: 20, slowPeriod: 10000 },
    { type: "CLOSE_ABOVE_EMA", period: 501 },
    { type: "CLOSE_ABOVE_EMA", period: 0 },
    { type: "CLOSE_BELOW_EMA", period: 501 },
    { type: "CLOSE_BELOW_EMA", period: 2.5 },
  ])("rejects out-of-bounds rule period %j", (rule) => {
    expect(strategyDefinitionSchema.safeParse({ ...VALID, entryRules: [rule] }).success).toBe(false);
  });

  it.each([
    { type: "EMA_CROSS_ABOVE", fastPeriod: 1, slowPeriod: 500 },
    { type: "EMA_CROSS_BELOW", fastPeriod: 1, slowPeriod: 500 },
    { type: "CLOSE_ABOVE_EMA", period: 500 },
    { type: "CLOSE_BELOW_EMA", period: 1 },
  ])("accepts in-bounds rule period %j", (rule) => {
    expect(strategyDefinitionSchema.safeParse({ ...VALID, entryRules: [rule] }).success).toBe(true);
  });
});
