import Decimal from "decimal.js";

/**
 * Internal helpers shared by metrics.ts and winners-losers.ts. Not
 * re-exported from index.ts — these are implementation details, not part of
 * the package's public surface.
 */

/**
 * Average of only the non-null entries of `values`. Returns `null` (not
 * Decimal(0)) when every entry is null, since "no data points" and "data
 * points that average to zero" are different, meaningful states — the same
 * distinction this package draws for profitFactor. Callers that want a
 * "0 if none present" default (e.g. averageR, per spec) do that conversion
 * themselves at the call site.
 */
export function averageNonNull(values: ReadonlyArray<Decimal | null>): Decimal | null {
  const nonNull = values.filter((value): value is Decimal => value !== null);
  if (nonNull.length === 0) {
    return null;
  }
  return nonNull.reduce((sum, value) => sum.plus(value), new Decimal(0)).dividedBy(nonNull.length);
}

/**
 * Same null-vs-zero convention as packages/backtester/src/metrics.ts's
 * profitFactor: `null` when there are zero losing trades in the group (the
 * denominator is genuinely undefined, not 0 and not Infinity) — including
 * the edge case where losing trades exist but their netPnl sums to exactly
 * zero (every loser broke exactly even), which is also a true
 * zero-denominator division and is treated as `null` for the same reason,
 * matching packages/backtester's `losingTrades === 0 || grossLoss.isZero()`
 * guard exactly. Otherwise grossProfit (>= 0) divided by the absolute value
 * of grossLoss (<= 0 by convention) — including the well-defined case of
 * losers present with zero grossProfit, which correctly falls out to
 * Decimal(0), not null.
 */
export function computeProfitFactor(
  grossProfit: Decimal,
  grossLoss: Decimal,
  losingCount: number,
): Decimal | null {
  if (losingCount === 0 || grossLoss.isZero()) {
    return null;
  }
  return grossProfit.dividedBy(grossLoss.abs());
}

/** netPnl > 0 is a winner; matches packages/backtester's convention exactly. */
export function isWinner(netPnl: Decimal): boolean {
  return netPnl.greaterThan(0);
}

/** netPnl <= 0 is a loser (a breakeven trade counts as a loser, not a winner). */
export function isLoser(netPnl: Decimal): boolean {
  return !isWinner(netPnl);
}
