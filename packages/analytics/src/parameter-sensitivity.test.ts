import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { compareParameterVariations, type ParameterVariation } from "./parameter-sensitivity";
import type { TradeAnalyticsMetrics } from "./metrics";

function metricsWithExpectancy(expectancy: number): TradeAnalyticsMetrics {
  return {
    tradeCount: 10,
    wins: 5,
    losses: 5,
    winRate: new Decimal(0.5),
    grossProfit: new Decimal(0),
    grossLoss: new Decimal(0),
    netPnl: new Decimal(0),
    averagePnl: new Decimal(0),
    expectancy: new Decimal(expectancy),
    averageR: new Decimal(0),
    profitFactor: null,
    averageWinner: new Decimal(0),
    averageLoser: new Decimal(0),
    largestWinner: new Decimal(0),
    largestLoser: new Decimal(0),
    maxDrawdown: new Decimal(0),
    maxDrawdownPercent: null,
    maximumConsecutiveWins: 0,
    maximumConsecutiveLosses: 0,
    mfeAverage: null,
    maeAverage: null,
    totalFees: new Decimal(0),
    averageSlippage: null,
  };
}

function variation(label: string, expectancy: number): ParameterVariation {
  return { label, parameters: { stopAtrMultiplier: 1 }, metrics: metricsWithExpectancy(expectancy) };
}

describe("compareParameterVariations", () => {
  it("warns when more than half the variations perform at less than 50% of the best expectancy", () => {
    const report = compareParameterVariations(variation("baseline", 100), [
      variation("v1", 10),
      variation("v2", 5),
      variation("v3", 90),
    ]);
    expect(report.isolatedPeakWarning).not.toBeNull();
  });

  it("returns no warning when variations form a stable region", () => {
    const report = compareParameterVariations(variation("baseline", 100), [
      variation("v1", 95),
      variation("v2", 90),
      variation("v3", 92),
    ]);
    expect(report.isolatedPeakWarning).toBeNull();
  });
});
