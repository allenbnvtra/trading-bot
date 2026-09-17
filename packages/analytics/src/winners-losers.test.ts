import { describe, expect, it } from "vitest";
import { compareWinnersLosers } from "./winners-losers";
import { D, makeTrade } from "./test-helpers";

describe("compareWinnersLosers", () => {
  it("returns safe defaults for empty input, with no condition", () => {
    const result = compareWinnersLosers([]);
    for (const group of [result.winners, result.losers, result.allTrades]) {
      expect(group.sampleSize).toBe(0);
      expect(group.averageR.toString()).toBe("0");
      expect(group.profitFactor).toBeNull();
      expect(group.winRate.toString()).toBe("0");
    }
    expect(result.condition).toBeUndefined();
  });

  it("returns safe defaults for empty input, with a condition supplied", () => {
    const result = compareWinnersLosers([], () => true);
    expect(result.condition).toBeDefined();
    expect(result.condition!.prevalenceAmongWinners.toString()).toBe("0");
    expect(result.condition!.prevalenceAmongLosers.toString()).toBe("0");
    expect(result.condition!.prevalenceAmongAll.toString()).toBe("0");
    expect(result.condition!.withCondition.sampleSize).toBe(0);
    expect(result.condition!.withoutCondition.sampleSize).toBe(0);
  });

  it("computes winners/losers/allTrades stats without a condition", () => {
    const trades = [
      makeTrade({ netPnl: D(100), rMultiple: D(2) }),
      makeTrade({ netPnl: D(50), rMultiple: D(1) }),
      makeTrade({ netPnl: D(-30), rMultiple: D(-1) }),
      makeTrade({ netPnl: D(-20), rMultiple: D(-0.7) }),
    ];
    const result = compareWinnersLosers(trades);

    expect(result.winners.sampleSize).toBe(2);
    expect(result.winners.averageR.toString()).toBe("1.5");
    // A pure-winners subset has zero losers -> profitFactor is null (trivially, no denominator).
    expect(result.winners.profitFactor).toBeNull();
    expect(result.winners.winRate.toString()).toBe("1");

    expect(result.losers.sampleSize).toBe(2);
    expect(result.losers.averageR.toString()).toBe(D(-1).plus(-0.7).dividedBy(2).toString());
    // A pure-losers subset has losers present with zero grossProfit -> Decimal(0), not null.
    expect(result.losers.profitFactor?.toString()).toBe("0");
    expect(result.losers.winRate.toString()).toBe("0");

    expect(result.allTrades.sampleSize).toBe(4);
    expect(result.allTrades.winRate.toString()).toBe("0.5");
    // grossProfit=150, grossLoss=-50 -> profitFactor = 3
    expect(result.allTrades.profitFactor?.toString()).toBe("3");
    expect(result.allTrades.averageR.toString()).toBe(
      D(2).plus(1).minus(1).minus(0.7).dividedBy(4).toString(),
    );

    expect(result.condition).toBeUndefined();
  });

  it("computes a condition that is MORE prevalent among losers than winners, without asserting causation, and the numbers are correct", () => {
    // 2 winners (1 SHORT), 2 losers (both SHORT) — SHORT is the "condition".
    // This deliberately makes the condition more common among losers than
    // winners; the test only checks the arithmetic, never a causal label.
    const w1 = makeTrade({ direction: "LONG", netPnl: D(100), rMultiple: D(2) });
    const w2 = makeTrade({ direction: "SHORT", netPnl: D(50), rMultiple: D(1) });
    const l1 = makeTrade({ direction: "SHORT", netPnl: D(-30), rMultiple: D(-1) });
    const l2 = makeTrade({ direction: "SHORT", netPnl: D(-20), rMultiple: D(-0.7) });
    const trades = [w1, w2, l1, l2];

    const isShort = (t: (typeof trades)[number]) => t.direction === "SHORT";
    const result = compareWinnersLosers(trades, isShort);

    expect(result.condition).toBeDefined();
    // 1 of 2 winners is SHORT
    expect(result.condition!.prevalenceAmongWinners.toString()).toBe("0.5");
    // 2 of 2 losers are SHORT — more prevalent among losers than winners.
    expect(result.condition!.prevalenceAmongLosers.toString()).toBe("1");
    // 3 of 4 trades overall are SHORT
    expect(result.condition!.prevalenceAmongAll.toString()).toBe("0.75");

    // withCondition = SHORT trades = w2, l1, l2 -> netPnl 50, -30, -20
    expect(result.condition!.withCondition.sampleSize).toBe(3);
    expect(result.condition!.withCondition.winRate.toString()).toBe(D(1).dividedBy(3).toString());
    // grossProfit=50, grossLoss=-50 -> profitFactor=1
    expect(result.condition!.withCondition.profitFactor?.toString()).toBe("1");
    expect(result.condition!.withCondition.averageR.toString()).toBe(
      D(1).minus(1).minus(0.7).dividedBy(3).toString(),
    );

    // withoutCondition = LONG trades = w1 only -> netPnl 100
    expect(result.condition!.withoutCondition.sampleSize).toBe(1);
    expect(result.condition!.withoutCondition.winRate.toString()).toBe("1");
    expect(result.condition!.withoutCondition.profitFactor).toBeNull();
    expect(result.condition!.withoutCondition.averageR.toString()).toBe("2");
  });

  it("handles a condition that never occurs, with no divide-by-zero", () => {
    const trades = [
      makeTrade({ netPnl: D(100) }),
      makeTrade({ netPnl: D(-20) }),
    ];
    const result = compareWinnersLosers(trades, () => false);

    expect(result.condition!.prevalenceAmongWinners.toString()).toBe("0");
    expect(result.condition!.prevalenceAmongLosers.toString()).toBe("0");
    expect(result.condition!.prevalenceAmongAll.toString()).toBe("0");
    expect(result.condition!.withCondition.sampleSize).toBe(0);
    expect(result.condition!.withCondition.profitFactor).toBeNull();
    expect(result.condition!.withCondition.averageR.toString()).toBe("0");
    expect(result.condition!.withoutCondition.sampleSize).toBe(2);
  });

  it("treats netPnl of exactly 0 as a loser, matching metrics.ts and packages/backtester", () => {
    const trades = [makeTrade({ netPnl: D(0) })];
    const result = compareWinnersLosers(trades);
    expect(result.winners.sampleSize).toBe(0);
    expect(result.losers.sampleSize).toBe(1);
  });
});
