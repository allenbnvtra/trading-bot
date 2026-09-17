import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import { calculateAtr } from "./atr";

const D = (value: string | number) => new Decimal(value);

let counter = 0;
function makeCandle(open: number, high: number, low: number, close: number): Candle {
  counter += 1;
  return {
    id: `candle-${counter}`,
    instrumentId: "instrument-1",
    timeframe: "1d",
    timestamp: new Date(Date.UTC(2024, 0, counter)),
    open: D(open),
    high: D(high),
    low: D(low),
    close: D(close),
    volume: D(1000),
  };
}

describe("calculateAtr", () => {
  it("computes a hand-verified ATR(3) over 5 candles", () => {
    // i0: H=10 L=8 C=9   -> TR0 = 10-8 = 2 (no previous close)
    // i1: H=11 L=9 C=10  -> TR1 = max(2, |11-9|=2, |9-9|=0) = 2
    // i2: H=12 L=10 C=11 -> TR2 = max(2, |12-9|=3, |10-9|=1) = 3
    //    Wait: previous close for i2 is close of i1 = 10, not i0.
    // Recompute carefully below using previous candle's close.
    const candles = [
      makeCandle(9, 10, 8, 9), // i0
      makeCandle(9, 11, 9, 10), // i1, prevClose=9
      makeCandle(10, 12, 10, 11), // i2, prevClose=10
      makeCandle(11, 9, 7, 8), // i3, prevClose=11
      makeCandle(8, 13, 11, 12), // i4, prevClose=8
    ];
    // TR0 = 10-8 = 2
    // TR1 = max(11-9=2, |11-9|=2, |9-9|=0) = 2
    // TR2 = max(12-10=2, |12-10|=2, |10-10|=0) = 2
    // TR3 = max(9-7=2, |9-11|=2, |7-11|=4) = 4
    // TR4 = max(13-11=2, |13-8|=5, |11-8|=3) = 5
    // seed at index2 = avg(2,2,2) = 2
    // atr3 = (2*2 + 4)/3 = 8/3 = 2.666667
    // atr4 = ((8/3)*2 + 5)/3 = 31/9 = 3.444444
    const result = calculateAtr(candles, 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect((result[2] as Decimal).toString()).toBe("2");
    expect((result[3] as Decimal).toFixed(6)).toBe("2.666667");
    expect((result[4] as Decimal).toFixed(6)).toBe("3.444444");
  });

  it("uses high-low only for the first candle (no previous close)", () => {
    const candles = [makeCandle(100, 105, 95, 102)];
    const result = calculateAtr(candles, 1);
    expect((result[0] as Decimal).toString()).toBe("10");
  });

  it("returns null for every index before the seed index and a real value from the seed index onward", () => {
    const candles = Array.from({ length: 6 }, (_, i) => makeCandle(10 + i, 12 + i, 9 + i, 11 + i));
    const result = calculateAtr(candles, 4);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
    expect(result[3]).not.toBeNull();
    expect(result[4]).not.toBeNull();
    expect(result[5]).not.toBeNull();
  });

  it("returns all nulls when candles.length < period", () => {
    const candles = [makeCandle(1, 2, 0, 1), makeCandle(1, 2, 0, 1)];
    const result = calculateAtr(candles, 5);
    expect(result).toEqual([null, null]);
  });

  it("throws when period is 0 or negative", () => {
    const candles = [makeCandle(1, 2, 0, 1)];
    expect(() => calculateAtr(candles, 0)).toThrow();
    expect(() => calculateAtr(candles, -1)).toThrow();
  });

  it("throws when candles is empty", () => {
    expect(() => calculateAtr([], 3)).toThrow();
  });
});
