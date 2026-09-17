import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateTradeAnalytics } from "./metrics";
import { D, DN, makeTrade, tradeWithPnl } from "./test-helpers";

describe("calculateTradeAnalytics", () => {
  it("returns safe defaults for zero trades, with no initialBalance", () => {
    const metrics = calculateTradeAnalytics([]);

    expect(metrics.tradeCount).toBe(0);
    expect(metrics.wins).toBe(0);
    expect(metrics.losses).toBe(0);
    expect(metrics.winRate.toString()).toBe("0");
    expect(metrics.grossProfit.toString()).toBe("0");
    expect(metrics.grossLoss.toString()).toBe("0");
    expect(metrics.netPnl.toString()).toBe("0");
    expect(metrics.averagePnl.toString()).toBe("0");
    expect(metrics.expectancy.toString()).toBe("0");
    expect(metrics.averageR.toString()).toBe("0");
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.averageWinner.toString()).toBe("0");
    expect(metrics.averageLoser.toString()).toBe("0");
    expect(metrics.largestWinner.toString()).toBe("0");
    expect(metrics.largestLoser.toString()).toBe("0");
    expect(metrics.maxDrawdown.toString()).toBe("0");
    // No initialBalance was supplied, so there's no baseline for a percentage.
    expect(metrics.maxDrawdownPercent).toBeNull();
    expect(metrics.maximumConsecutiveWins).toBe(0);
    expect(metrics.maximumConsecutiveLosses).toBe(0);
    expect(metrics.mfeAverage).toBeNull();
    expect(metrics.maeAverage).toBeNull();
    expect(metrics.totalFees.toString()).toBe("0");
    expect(metrics.averageSlippage).toBeNull();
  });

  it("returns maxDrawdownPercent as Decimal(0) for zero trades when initialBalance IS supplied", () => {
    const metrics = calculateTradeAnalytics([], { initialBalance: D(10000) });
    expect(metrics.maxDrawdown.toString()).toBe("0");
    expect(metrics.maxDrawdownPercent?.toString()).toBe("0");
  });

  it("handles all winners (profitFactor is null since there are no losses)", () => {
    const trades = [
      tradeWithPnl(100, { rMultiple: D(1) }),
      tradeWithPnl(200, { rMultiple: D(2) }),
      tradeWithPnl(50, { rMultiple: D(0.5) }),
    ];
    const metrics = calculateTradeAnalytics(trades);

    expect(metrics.tradeCount).toBe(3);
    expect(metrics.wins).toBe(3);
    expect(metrics.losses).toBe(0);
    expect(metrics.winRate.toString()).toBe("1");
    expect(metrics.grossProfit.toString()).toBe("350");
    expect(metrics.grossLoss.toString()).toBe("0");
    expect(metrics.netPnl.toString()).toBe("350");
    expect(metrics.averagePnl.toString()).toBe(D(350).dividedBy(3).toString());
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.averageWinner.toString()).toBe(D(350).dividedBy(3).toString());
    expect(metrics.averageLoser.toString()).toBe("0");
    expect(metrics.largestWinner.toString()).toBe("200");
    expect(metrics.largestLoser.toString()).toBe("0");
    expect(metrics.maximumConsecutiveWins).toBe(3);
    expect(metrics.maximumConsecutiveLosses).toBe(0);
    // expectancy = winRate(1) * averageWinner - (1-1)*abs(averageLoser) = averageWinner
    expect(metrics.expectancy.toString()).toBe(D(350).dividedBy(3).toString());
    expect(metrics.averageR.toString()).toBe(D(3.5).dividedBy(3).toString());
  });

  it("handles all losers (profitFactor is Decimal(0), NOT null, since losers exist)", () => {
    const trades = [tradeWithPnl(-100, { rMultiple: D(-1) }), tradeWithPnl(-50, { rMultiple: D(-0.5) })];
    const metrics = calculateTradeAnalytics(trades);

    expect(metrics.tradeCount).toBe(2);
    expect(metrics.wins).toBe(0);
    expect(metrics.losses).toBe(2);
    expect(metrics.winRate.toString()).toBe("0");
    expect(metrics.grossProfit.toString()).toBe("0");
    expect(metrics.grossLoss.toString()).toBe("-150");
    expect(metrics.netPnl.toString()).toBe("-150");
    // There ARE losing trades, so the denominator is well-defined: 0 / 150 = 0.
    expect(metrics.profitFactor).not.toBeNull();
    expect((metrics.profitFactor as Decimal).toString()).toBe("0");
    expect(metrics.averageLoser.toString()).toBe("-75");
    expect(metrics.largestLoser.toString()).toBe("-100");
    expect(metrics.maximumConsecutiveLosses).toBe(2);
    // expectancy = winRate(0)*averageWinner(0) - (1-0)*abs(-75) = -75
    expect(metrics.expectancy.toString()).toBe("-75");
  });

  it("treats a netPnl of exactly 0 as a loss (not a win), matching packages/backtester", () => {
    const trades = [tradeWithPnl(0)];
    const metrics = calculateTradeAnalytics(trades);
    expect(metrics.wins).toBe(0);
    expect(metrics.losses).toBe(1);
  });

  it("null-vs-zero for profitFactor: losers whose netPnl sums to exactly zero is treated as a true zero-denominator (null), not Decimal(0)", () => {
    // Two "losing" trades (netPnl <= 0) that net out to exactly 0: e.g. one
    // breakeven trade. grossLoss.isZero() is true even though losingTrades > 0.
    const trades = [tradeWithPnl(0), tradeWithPnl(100)];
    const metrics = calculateTradeAnalytics(trades);
    expect(metrics.losses).toBe(1);
    expect(metrics.grossLoss.toString()).toBe("0");
    expect(metrics.profitFactor).toBeNull();
  });

  it("computes a mixed win/loss scenario end to end, including rMultiple/mfe/mae/slippage null-skipping", () => {
    // netPnl sequence (chronological): +100, -40, +60, -30, -10
    const trades = [
      makeTrade({ netPnl: D(100), fees: D(1), rMultiple: D(2), mfe: D(150), mae: D(-20), slippage: D(1) }),
      makeTrade({ netPnl: D(-40), fees: D(2), rMultiple: null, mfe: null, mae: D(-45), slippage: null }),
      makeTrade({ netPnl: D(60), fees: D(1), rMultiple: D(1.5), mfe: D(70), mae: D(-10), slippage: D(2) }),
      makeTrade({ netPnl: D(-30), fees: D(2), rMultiple: D(-1), mfe: null, mae: null, slippage: D(0.5) }),
      makeTrade({ netPnl: D(-10), fees: D(1), rMultiple: D(-0.5), mfe: D(5), mae: D(-15), slippage: null }),
    ];
    const metrics = calculateTradeAnalytics(trades, { initialBalance: D(1000) });

    expect(metrics.tradeCount).toBe(5);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(3);
    expect(metrics.winRate.toString()).toBe("0.4");
    expect(metrics.grossProfit.toString()).toBe("160");
    expect(metrics.grossLoss.toString()).toBe("-80");
    expect(metrics.netPnl.toString()).toBe("80");
    expect(metrics.averagePnl.toString()).toBe("16");
    expect((metrics.profitFactor as Decimal).toString()).toBe("2");
    expect(metrics.averageWinner.toString()).toBe("80");
    expect(metrics.averageLoser.toString()).toBe(D(-80).dividedBy(3).toString());
    expect(metrics.largestWinner.toString()).toBe("100");
    expect(metrics.largestLoser.toString()).toBe("-40");
    expect(metrics.maximumConsecutiveWins).toBe(1);
    expect(metrics.maximumConsecutiveLosses).toBe(2);

    // expectancy = 0.4*80 - 0.6*abs(-80/3)
    const expectedExpectancy = D(0.4).times(80).minus(D(0.6).times(D(80).dividedBy(3)));
    expect(metrics.expectancy.toString()).toBe(expectedExpectancy.toString());

    // averageR skips the null (trade 2): (2 + 1.5 - 1 - 0.5) / 4
    expect(metrics.averageR.toString()).toBe(D(2).plus(1.5).minus(1).minus(0.5).dividedBy(4).toString());

    // mfeAverage skips nulls (trades 2 and 4): (150 + 70 + 5) / 3
    expect(metrics.mfeAverage?.toString()).toBe(D(225).dividedBy(3).toString());
    // maeAverage: no nulls among the 4 defined values: (-20 -45 -10 -15) / 4
    expect(metrics.maeAverage?.toString()).toBe(D(-90).dividedBy(4).toString());
    // averageSlippage skips nulls (trades 2 and 5): (1 + 2 + 0.5) / 3
    expect(metrics.averageSlippage?.toString()).toBe(D(3.5).dividedBy(3).toString());
    // totalFees is a plain sum, no null-skipping needed (fees is never null)
    expect(metrics.totalFees.toString()).toBe("7");

    // equity curve: 1000 -> 1100 (peak) -> 1060 -> 1120 (new peak) -> 1090 -> 1080
    // largest decline (40) first occurs at step 2 (peak 1100 -> 1060) and ties
    // again at step 5 (peak 1120 -> 1080); the FIRST occurrence's percent wins.
    expect(metrics.maxDrawdown.toString()).toBe("40");
    expect(metrics.maxDrawdownPercent?.toNumber()).toBeCloseTo((40 / 1100) * 100, 6);
  });

  it("computes maxDrawdown from a 0 baseline (and keeps maxDrawdownPercent null) when initialBalance is omitted", () => {
    // Same netPnl sequence as above, but with no initialBalance.
    const trades = [
      tradeWithPnl(100),
      tradeWithPnl(-40),
      tradeWithPnl(60),
      tradeWithPnl(-30),
      tradeWithPnl(-10),
    ];
    const metrics = calculateTradeAnalytics(trades);

    // equity curve (starting at 0): 0 -> 100 (peak) -> 60 -> 120 (peak) -> 90 -> 80
    // decline of 40 first occurs at step 2 (100 -> 60), ties again at step 5 (120 -> 80).
    expect(metrics.maxDrawdown.toString()).toBe("40");
    expect(metrics.maxDrawdownPercent).toBeNull();
  });

  it("skips null riskAmount/rMultiple entirely rather than treating them as zero (JOURNAL trades with no plannedRisk)", () => {
    const trades = [
      makeTrade({ netPnl: D(10), riskAmount: null, rMultiple: null }),
      makeTrade({ netPnl: D(20), riskAmount: DN(50), rMultiple: D(2) }),
    ];
    const metrics = calculateTradeAnalytics(trades);
    // Only the second trade has a non-null rMultiple; average is just 2, not (0+2)/2=1.
    expect(metrics.averageR.toString()).toBe("2");
  });
});
