import { describe, expect, it } from "vitest";
import { DEFAULT_GROUP_BY, groupTradeAnalytics } from "./grouping";
import { D, makeTrade } from "./test-helpers";

describe("groupTradeAnalytics", () => {
  it("returns an empty array for empty input", () => {
    expect(groupTradeAnalytics([], ["strategyId"])).toEqual([]);
  });

  it("throws rather than silently aggregating everything when groupBy is empty", () => {
    const trades = [makeTrade({ netPnl: D(10) })];
    expect(() => groupTradeAnalytics(trades, [])).toThrow();
  });

  it("groups by a single field", () => {
    const trades = [
      makeTrade({ direction: "LONG", netPnl: D(100) }),
      makeTrade({ direction: "LONG", netPnl: D(50) }),
      makeTrade({ direction: "SHORT", netPnl: D(-20) }),
    ];

    const groups = groupTradeAnalytics(trades, ["direction"]);

    expect(groups).toHaveLength(2);
    const longGroup = groups.find((g) => g.key.direction === "LONG")!;
    const shortGroup = groups.find((g) => g.key.direction === "SHORT")!;

    expect(longGroup.key).toEqual({ direction: "LONG" });
    expect(longGroup.trades).toHaveLength(2);
    expect(longGroup.metrics.tradeCount).toBe(2);
    expect(longGroup.metrics.netPnl.toString()).toBe("150");

    expect(shortGroup.key).toEqual({ direction: "SHORT" });
    expect(shortGroup.trades).toHaveLength(1);
    expect(shortGroup.metrics.netPnl.toString()).toBe("-20");
  });

  it("preserves group order as the order each key combination first appears", () => {
    const trades = [
      makeTrade({ direction: "SHORT", netPnl: D(-20) }),
      makeTrade({ direction: "LONG", netPnl: D(100) }),
      makeTrade({ direction: "SHORT", netPnl: D(10) }),
    ];
    const groups = groupTradeAnalytics(trades, ["direction"]);
    expect(groups.map((g) => g.key.direction)).toEqual(["SHORT", "LONG"]);
  });

  it("groups by a composite key (multiple fields) and never merges different strategyVersionIds by default", () => {
    const tA = makeTrade({ strategyId: "S1", strategyVersionId: "V1", netPnl: D(100) });
    const tB = makeTrade({ strategyId: "S1", strategyVersionId: "V2", netPnl: D(-100) });
    const tC = makeTrade({ strategyId: "S2", strategyVersionId: "V1", netPnl: D(50) });
    const trades = [tA, tB, tC];

    const groups = groupTradeAnalytics(trades, DEFAULT_GROUP_BY);

    expect(DEFAULT_GROUP_BY).toEqual(["strategyId", "strategyVersionId"]);
    // Three distinct (strategyId, strategyVersionId) pairs -> three groups,
    // even though S1/V1 and S1/V2 share a strategyId.
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.trades).toHaveLength(1);
    }

    const s1v1 = groups.find((g) => g.key.strategyVersionId === "V1" && g.key.strategyId === "S1")!;
    const s1v2 = groups.find((g) => g.key.strategyVersionId === "V2" && g.key.strategyId === "S1")!;
    expect(s1v1.metrics.netPnl.toString()).toBe("100");
    expect(s1v2.metrics.netPnl.toString()).toBe("-100");
  });

  it("an explicit coarser groupBy (strategyId alone) is allowed to combine different strategyVersionIds", () => {
    const tA = makeTrade({ strategyId: "S1", strategyVersionId: "V1", netPnl: D(100) });
    const tB = makeTrade({ strategyId: "S1", strategyVersionId: "V2", netPnl: D(-100) });
    const tC = makeTrade({ strategyId: "S2", strategyVersionId: "V1", netPnl: D(50) });
    const trades = [tA, tB, tC];

    const groups = groupTradeAnalytics(trades, ["strategyId"]);

    expect(groups).toHaveLength(2);
    const s1 = groups.find((g) => g.key.strategyId === "S1")!;
    const s2 = groups.find((g) => g.key.strategyId === "S2")!;
    expect(s1.trades).toHaveLength(2);
    expect(s1.metrics.netPnl.toString()).toBe("0");
    expect(s2.trades).toHaveLength(1);
    expect(s2.metrics.netPnl.toString()).toBe("50");
  });

  it("passes options.initialBalance through to each group's metrics", () => {
    const trades = [
      makeTrade({ direction: "LONG", netPnl: D(100) }),
      makeTrade({ direction: "LONG", netPnl: D(-50) }),
    ];
    const groups = groupTradeAnalytics(trades, ["direction"], { initialBalance: D(1000) });
    expect(groups[0]!.metrics.maxDrawdownPercent).not.toBeNull();
  });
});
