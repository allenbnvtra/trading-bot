import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeJournalTradeClose } from "./journal-trades";

/**
 * computeJournalTradeClose is the pure P&L core extracted from
 * closeJournalTrade (see that module's doc comment) — calls only
 * packages/risk-engine functions, never reimplements the math.
 */
describe("computeJournalTradeClose", () => {
  it("computes gross/net P&L and rMultiple for a winning LONG trade with a real risk baseline", () => {
    const result = computeJournalTradeClose(
      "LONG",
      new Decimal("5100.25"),
      new Decimal("5123.75"),
      1,
      new Decimal("50"),
      new Decimal("2.50"),
      new Decimal("627.5"),
    );

    expect(result.grossPnl.toString()).toBe("1175");
    expect(result.netPnl.toString()).toBe("1172.5");
    expect(result.rMultiple).not.toBeNull();
    expect(result.rMultiple?.toString()).toBe("1.8685258964143426295"); // 1172.5 / 627.5
  });

  it("computes a losing SHORT trade correctly", () => {
    const result = computeJournalTradeClose(
      "SHORT",
      new Decimal("100"),
      new Decimal("105"),
      2,
      new Decimal("10"),
      new Decimal("1"),
      new Decimal("100"),
    );

    // SHORT: (entry - exit) * pointValue * qty = (100 - 105) * 10 * 2 = -100
    expect(result.grossPnl.toString()).toBe("-100");
    expect(result.netPnl.toString()).toBe("-101");
    expect(result.rMultiple?.toString()).toBe("-1.01");
  });

  it("returns rMultiple: null when there is no real risk baseline (plannedRisk null), never a fabricated 0", () => {
    const result = computeJournalTradeClose(
      "LONG",
      new Decimal("100"),
      new Decimal("110"),
      1,
      new Decimal("10"),
      new Decimal("0"),
      null,
    );

    expect(result.grossPnl.toString()).toBe("100");
    expect(result.netPnl.toString()).toBe("100");
    expect(result.rMultiple).toBeNull();
  });

  it("treats plannedRisk of exactly zero the same as null, rather than throwing", () => {
    // createJournalTradeSchema permits "0" for plannedRisk (a caller who
    // genuinely doesn't know the risk yet can't be distinguished from one
    // who typed 0), so this must not throw at close time.
    const result = computeJournalTradeClose(
      "LONG",
      new Decimal("100"),
      new Decimal("110"),
      1,
      new Decimal("10"),
      new Decimal("0"),
      new Decimal("0"),
    );

    expect(result.rMultiple).toBeNull();
  });

  it("computes outcome WIN when netPnl is positive, LOSS when negative, BREAKEVEN when exactly zero", () => {
    const win = computeJournalTradeClose(
      "LONG",
      new Decimal("100"),
      new Decimal("110"),
      1,
      new Decimal("10"),
      new Decimal("0"),
      null,
    );
    expect(win.netPnl.toString()).toBe("100");
    expect(win.outcome).toBe("WIN");

    const loss = computeJournalTradeClose(
      "LONG",
      new Decimal("100"),
      new Decimal("90"),
      1,
      new Decimal("10"),
      new Decimal("0"),
      null,
    );
    expect(loss.netPnl.toString()).toBe("-100");
    expect(loss.outcome).toBe("LOSS");

    const breakeven = computeJournalTradeClose(
      "LONG",
      new Decimal("100"),
      new Decimal("100"),
      1,
      new Decimal("10"),
      new Decimal("0"),
      null,
    );
    expect(breakeven.netPnl.toString()).toBe("0");
    expect(breakeven.outcome).toBe("BREAKEVEN");
  });
});
