import type { TradeAnalyticsMetrics } from "./metrics";

/**
 * Foundation only: compares already-computed metrics from backtests the
 * caller ran; this module never runs a backtest itself. Per
 * docs/research-methodology.md "Overfitting and parameter mining": prefer
 * stable, wide parameter regions over isolated performance peaks.
 */
export interface ParameterVariation {
  label: string;
  parameters: Record<string, unknown>;
  metrics: TradeAnalyticsMetrics;
}

export interface ParameterSensitivityReport {
  baseline: ParameterVariation;
  variations: ParameterVariation[];
  isolatedPeakWarning: string | null;
}

export function compareParameterVariations(
  baseline: ParameterVariation,
  variations: ParameterVariation[],
): ParameterSensitivityReport {
  if (variations.length === 0) {
    return { baseline, variations: [], isolatedPeakWarning: null };
  }

  // The best expectancy is found across baseline + variations together
  // (the baseline itself may be the peak), but "how many underperform" is
  // measured only over the tested `variations`, not the baseline itself,
  // which is the reference point rather than something being evaluated.
  const all = [baseline, ...variations];
  const expectancies = all.map((v) => v.metrics.expectancy);
  const maxExpectancy = expectancies.reduce((max, e) => (e.greaterThan(max) ? e : max), expectancies[0]!);
  const halfOfMax = maxExpectancy.times(0.5);
  const belowHalfCount = variations.filter((v) => v.metrics.expectancy.lessThan(halfOfMax)).length;

  const isolatedPeakWarning =
    belowHalfCount / variations.length > 0.5
      ? "More than half of the tested parameter variations perform at less than 50% of the " +
        "best variation's expectancy. This may be an isolated performance peak rather than a " +
        "stable region. See docs/research-methodology.md 'Overfitting and parameter mining'."
      : null;

  return { baseline, variations, isolatedPeakWarning };
}
