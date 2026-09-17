import Decimal from "decimal.js";
import type { Candle } from "@trading-copilot/trading-domain";

/**
 * Average True Range, using Wilder's smoothing.
 *
 * True Range at index i is:
 *   max(high[i]-low[i], abs(high[i]-close[i-1]), abs(low[i]-close[i-1]))
 * For i === 0 there is no previous close, so TR is just high[0]-low[0].
 *
 * Output is the same length as `candles`. Indexes before `period-1` are
 * `null` (not enough history yet). Index `period-1` is seeded as the simple
 * average of TR[0..period-1]; every index after that uses Wilder's
 * recursion: atr[i] = (prevAtr*(period-1) + TR[i]) / period.
 */
export function calculateAtr(candles: Candle[], period: number): Array<Decimal | null> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error("calculateAtr: period must be an integer >= 1");
  }
  if (candles.length === 0) {
    throw new Error("calculateAtr: candles must not be empty");
  }

  const trueRanges: Decimal[] = candles.map((candle, i) => {
    const highLow = candle.high.minus(candle.low);
    if (i === 0) {
      return highLow;
    }
    const previousClose = (candles[i - 1] as Candle).close;
    const highClose = candle.high.minus(previousClose).abs();
    const lowClose = candle.low.minus(previousClose).abs();
    return Decimal.max(highLow, highClose, lowClose);
  });

  const result: Array<Decimal | null> = new Array(candles.length).fill(null) as Array<
    Decimal | null
  >;

  if (candles.length < period) {
    return result;
  }

  let seedSum = new Decimal(0);
  for (let i = 0; i < period; i += 1) {
    seedSum = seedSum.plus(trueRanges[i] as Decimal);
  }
  const seed = seedSum.dividedBy(period);
  result[period - 1] = seed;

  let previousAtr = seed;
  for (let i = period; i < candles.length; i += 1) {
    const current = previousAtr
      .times(period - 1)
      .plus(trueRanges[i] as Decimal)
      .dividedBy(period);
    result[i] = current;
    previousAtr = current;
  }

  return result;
}
