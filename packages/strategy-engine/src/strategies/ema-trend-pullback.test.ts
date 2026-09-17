import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import {
  emaTrendPullbackParametersSchema,
  evaluateEmaTrendPullback,
  type EmaTrendPullbackParameters,
} from "./ema-trend-pullback";

const D = (value: string | number) => new Decimal(value);

/** Flat OHLC candles (open=high=low=close) built from a close series. */
function makeCandlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    id: `candle-${i}`,
    instrumentId: "instrument-1",
    timeframe: "1d",
    timestamp: new Date(Date.UTC(2024, 0, i + 1)),
    open: D(close),
    high: D(close),
    low: D(close),
    close: D(close),
    volume: D(1000),
  }));
}

const baseParams: EmaTrendPullbackParameters = {
  fastEmaPeriod: 2,
  slowEmaPeriod: 3,
  atrPeriod: 2,
  stopAtrMultiplier: 1,
  targetAtrMultiplier: 2,
  allowLong: true,
  allowShort: true,
};

// Hand-verified (see comments in the risk/EMA tests for the method):
// EMA(2): seed@1=101, idx2=103, idx3=103, idx4=106.333...
// EMA(3): seed@2=102, idx3=102.5, idx4=105.25
// At index 4: fastEma>slowEma (uptrend), close[3]=103<=fastEma[3]=103 (pullback),
// close[4]=108>fastEma[4]=106.33 (breakout) -> LONG signal at index 4.
const UPTREND_CLOSES = [100, 102, 104, 103, 108];

// Mirror of the uptrend series for SHORT.
// EMA(2): seed@1=99, idx2=97, idx3=97, idx4=93.667
// EMA(3): seed@2=98, idx3=97.5, idx4=94.75
// At index 4: fastEma<slowEma (downtrend), close[3]=97>=fastEma[3]=97 (pullback),
// close[4]=92<fastEma[4]=93.667 (breakdown) -> SHORT signal at index 4.
const DOWNTREND_CLOSES = [100, 98, 96, 97, 92];

describe("evaluateEmaTrendPullback", () => {
  it("fires a LONG signal exactly at the expected index in a constructed series", () => {
    const candles = makeCandlesFromCloses(UPTREND_CLOSES);
    const signals = evaluateEmaTrendPullback(candles, baseParams);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.index).toBe(4);
    expect(signals[0]?.direction).toBe("LONG");
    expect(signals[0]?.timestamp).toEqual(candles[4]?.timestamp);
    expect(signals[0]?.closeAtSignal.toString()).toBe("108");
    expect(signals[0]?.entryReason).toMatch(/EMA/);
  });

  it("fires a SHORT signal exactly at the expected index in the mirrored series", () => {
    const candles = makeCandlesFromCloses(DOWNTREND_CLOSES);
    const signals = evaluateEmaTrendPullback(candles, baseParams);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.index).toBe(4);
    expect(signals[0]?.direction).toBe("SHORT");
    expect(signals[0]?.closeAtSignal.toString()).toBe("92");
  });

  it("produces no signal while the EMAs are still warming up (null)", () => {
    // Only 4 closes: slowEma (period 3) is only non-null from index 2, but
    // the crossover pattern needs index 4 in the hand-verified series above.
    const candles = makeCandlesFromCloses(UPTREND_CLOSES.slice(0, 4));
    const signals = evaluateEmaTrendPullback(candles, baseParams);
    expect(signals).toHaveLength(0);
  });

  it("produces no signal at all when there are fewer candles than the slow EMA period", () => {
    const candles = makeCandlesFromCloses([100, 101]);
    const signals = evaluateEmaTrendPullback(candles, baseParams);
    expect(signals).toHaveLength(0);
  });

  it("suppresses LONG signals when allowLong is false", () => {
    const candles = makeCandlesFromCloses(UPTREND_CLOSES);
    const signals = evaluateEmaTrendPullback(candles, { ...baseParams, allowLong: false });
    expect(signals).toHaveLength(0);
  });

  it("suppresses SHORT signals when allowShort is false", () => {
    const candles = makeCandlesFromCloses(DOWNTREND_CLOSES);
    const signals = evaluateEmaTrendPullback(candles, { ...baseParams, allowShort: false });
    expect(signals).toHaveLength(0);
  });

  it("only ever reads candles[0..i] to decide about index i (no look-ahead)", () => {
    // Truncating the series right after the signal candle must not change
    // whether/where the signal fired for the retained indexes.
    const fullCandles = makeCandlesFromCloses(UPTREND_CLOSES);
    const truncated = fullCandles.slice(0, 5);
    const fullSignals = evaluateEmaTrendPullback(fullCandles, baseParams);
    const truncatedSignals = evaluateEmaTrendPullback(truncated, baseParams);
    expect(truncatedSignals).toEqual(fullSignals);
  });
});

describe("emaTrendPullbackParametersSchema", () => {
  it("accepts the documented v1.0.0 default parameters", () => {
    const result = emaTrendPullbackParametersSchema.safeParse(baseParams);
    expect(result.success).toBe(true);
  });

  it("rejects fastEmaPeriod: 0", () => {
    const result = emaTrendPullbackParametersSchema.safeParse({ ...baseParams, fastEmaPeriod: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative stopAtrMultiplier", () => {
    const result = emaTrendPullbackParametersSchema.safeParse({
      ...baseParams,
      stopAtrMultiplier: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown parameter keys", () => {
    const result = emaTrendPullbackParametersSchema.safeParse({
      ...baseParams,
      unknownParam: 123,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer periods", () => {
    const result = emaTrendPullbackParametersSchema.safeParse({
      ...baseParams,
      fastEmaPeriod: 2.5,
    });
    expect(result.success).toBe(false);
  });

  it("causes evaluateEmaTrendPullback to throw on invalid parameters", () => {
    const candles = makeCandlesFromCloses(UPTREND_CLOSES);
    expect(() =>
      evaluateEmaTrendPullback(candles, { ...baseParams, fastEmaPeriod: 0 }),
    ).toThrow();
  });
});
