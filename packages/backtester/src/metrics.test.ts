import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateBacktestMetrics } from "./metrics";
import { D } from "./test-helpers";

function trade(netPnl: number | string, rMultiple: number | string) {
  return { netPnl: D(netPnl), rMultiple: D(rMultiple) };
}

describe("calculateBacktestMetrics", () => {
  it("returns safe defaults for zero trades", () => {
    const metrics = calculateBacktestMetrics([], D(10000));
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winningTrades).toBe(0);
    expect(metrics.losingTrades).toBe(0);
    expect(metrics.winRate.toString()).toBe("0");
    expect(metrics.grossProfit.toString()).toBe("0");
    expect(metrics.grossLoss.toString()).toBe("0");
    expect(metrics.netProfit.toString()).toBe("0");
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.averageTrade.toString()).toBe("0");
    expect(metrics.averageR.toString()).toBe("0");
    expect(metrics.largestWin.toString()).toBe("0");
    expect(metrics.largestLoss.toString()).toBe("0");
    expect(metrics.averageWin.toString()).toBe("0");
    expect(metrics.averageLoss.toString()).toBe("0");
    expect(metrics.maxDrawdown.toString()).toBe("0");
    expect(metrics.maxDrawdownPercent.toString()).toBe("0");
    expect(metrics.maximumConsecutiveWins).toBe(0);
    expect(metrics.maximumConsecutiveLosses).toBe(0);
    expect(metrics.expectancy.toString()).toBe("0");
  });

  it("handles all winners (profitFactor undefined -> null since there are no losses)", () => {
    const trades = [trade(100, 1), trade(200, 2), trade(50, 0.5)];
    const metrics = calculateBacktestMetrics(trades, D(10000));

    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winningTrades).toBe(3);
    expect(metrics.losingTrades).toBe(0);
    expect(metrics.winRate.toString()).toBe("1");
    expect(metrics.grossProfit.toString()).toBe("350");
    expect(metrics.grossLoss.toString()).toBe("0");
    expect(metrics.netProfit.toString()).toBe("350");
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.largestWin.toString()).toBe("200");
    expect(metrics.largestLoss.toString()).toBe("0");
    expect(metrics.averageWin.toString()).toBe(new Decimal(350).dividedBy(3).toString());
    expect(metrics.averageLoss.toString()).toBe("0");
    expect(metrics.maximumConsecutiveWins).toBe(3);
    expect(metrics.maximumConsecutiveLosses).toBe(0);
  });

  it("handles all losers", () => {
    const trades = [trade(-100, -1), trade(-50, -0.5)];
    const metrics = calculateBacktestMetrics(trades, D(10000));

    expect(metrics.totalTrades).toBe(2);
    expect(metrics.winningTrades).toBe(0);
    expect(metrics.losingTrades).toBe(2);
    expect(metrics.winRate.toString()).toBe("0");
    expect(metrics.grossProfit.toString()).toBe("0");
    expect(metrics.grossLoss.toString()).toBe("-150");
    expect(metrics.netProfit.toString()).toBe("-150");
    // There ARE losing trades here, so profitFactor is well-defined (not
    // null): grossProfit(0) / abs(grossLoss) = 0. null is reserved for the
    // "zero losing trades" case where the denominator itself is undefined.
    expect((metrics.profitFactor as Decimal).toString()).toBe("0");
  });

  it("computes a mixed win/loss scenario end to end", () => {
    // netPnl sequence (chronological): +100, -40, +60, -30, -10
    const trades = [trade(100, 2), trade(-40, -1), trade(60, 1.5), trade(-30, -1), trade(-10, -0.5)];
    const metrics = calculateBacktestMetrics(trades, D(1000));

    expect(metrics.totalTrades).toBe(5);
    expect(metrics.winningTrades).toBe(2);
    expect(metrics.losingTrades).toBe(3);
    expect(metrics.winRate.toString()).toBe("0.4");
    expect(metrics.grossProfit.toString()).toBe("160");
    expect(metrics.grossLoss.toString()).toBe("-80");
    expect(metrics.netProfit.toString()).toBe("80");
    expect((metrics.profitFactor as Decimal).toString()).toBe("2");
    expect(metrics.averageTrade.toString()).toBe("16");
    expect(metrics.largestWin.toString()).toBe("100");
    expect(metrics.largestLoss.toString()).toBe("-40");
    expect(metrics.averageWin.toString()).toBe("80");
    expect(metrics.averageLoss.toString()).toBe(new Decimal(-80).dividedBy(3).toString());
    expect(metrics.maximumConsecutiveWins).toBe(1);
    expect(metrics.maximumConsecutiveLosses).toBe(2);

    // equity curve: 1000 -> 1100 (peak) -> 1060 -> 1120 (new peak) -> 1090 -> 1080
    // The largest absolute decline (40) first occurs at step 2 (peak 1100 ->
    // 1060) and ties again at step 5 (peak 1120 -> 1080). Ties keep the
    // FIRST occurrence's percentage (a documented, deterministic tie-break),
    // so percent uses peak=1100, not the later peak=1120.
    expect(metrics.maxDrawdown.toString()).toBe("40");
    expect(metrics.maxDrawdownPercent.toNumber()).toBeCloseTo((40 / 1100) * 100, 6);
  });

  it("returns netProfit equal to the sum of trades' netPnl", () => {
    const trades = [trade(10, 1), trade(-5, -0.5), trade(20, 2)];
    const metrics = calculateBacktestMetrics(trades, D(500));
    const expectedSum = trades.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
    expect(metrics.netProfit.toString()).toBe(expectedSum.toString());
    expect(metrics.winningTrades + metrics.losingTrades).toBe(metrics.totalTrades);
  });

  it("treats a netPnl of exactly 0 as a loss (not a win)", () => {
    const trades = [trade(0, 0)];
    const metrics = calculateBacktestMetrics(trades, D(1000));
    expect(metrics.winningTrades).toBe(0);
    expect(metrics.losingTrades).toBe(1);
  });
});
