import Decimal from "decimal.js";

/**
 * Exponential Moving Average.
 *
 * Output is the same length as `values`. Indexes `0..period-2` are `null`
 * because there is not yet enough history to compute a value — we never
 * fabricate an EMA before the window is full. Index `period-1` is seeded as
 * the simple average of `values[0..period-1]`; every index after that uses
 * the standard EMA recursion with multiplier `2/(period+1)`.
 */
export function calculateEma(values: Decimal[], period: number): Array<Decimal | null> {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error("calculateEma: period must be an integer >= 1");
  }
  if (values.length === 0) {
    throw new Error("calculateEma: values must not be empty");
  }

  const result: Array<Decimal | null> = new Array(values.length).fill(null) as Array<
    Decimal | null
  >;

  if (values.length < period) {
    return result;
  }

  let seedSum = new Decimal(0);
  for (let i = 0; i < period; i += 1) {
    seedSum = seedSum.plus(values[i] as Decimal);
  }
  const seed = seedSum.dividedBy(period);
  result[period - 1] = seed;

  const multiplier = new Decimal(2).dividedBy(period + 1);
  let previous = seed;
  for (let i = period; i < values.length; i += 1) {
    const current = (values[i] as Decimal).minus(previous).times(multiplier).plus(previous);
    result[i] = current;
    previous = current;
  }

  return result;
}
