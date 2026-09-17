import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { mergeNormalizedTradesChronologically } from "./analytics-adapter";

/**
 * mergeNormalizedTradesChronologically is the pure merge step extracted from
 * getNormalizedTrades — see that function's doc comment. Both source lists
 * are individually sorted by the database query, but concatenation alone
 * does not produce a globally chronological list when both sources are
 * non-empty and interleaved in time; this test constructs exactly that case.
 */
function makeTrade(overrides: Partial<NormalizedTrade> & { id: string; entryTimestamp: Date }): NormalizedTrade {
  return {
    source: "BACKTEST",
    strategyId: "strategy-1",
    strategyVersionId: "version-1",
    instrumentId: "instrument-1",
    direction: "LONG",
    executionMode: "BACKTEST",
    exitTimestamp: overrides.entryTimestamp,
    entryPrice: new Decimal(100),
    exitPrice: new Decimal(110),
    quantity: 1,
    grossPnl: new Decimal(10),
    fees: new Decimal(0),
    netPnl: new Decimal(10),
    riskAmount: new Decimal(5),
    rMultiple: new Decimal(2),
    mfe: null,
    mae: null,
    slippage: null,
    ...overrides,
  };
}

describe("mergeNormalizedTradesChronologically", () => {
  it("interleaves two individually-sorted lists into one chronological list", () => {
    // Backtest trades (already sorted): Jan 1, Jan 5, Jan 10.
    const backtestTrades = [
      makeTrade({ id: "bt-1", entryTimestamp: new Date("2024-01-01T00:00:00.000Z") }),
      makeTrade({ id: "bt-2", entryTimestamp: new Date("2024-01-05T00:00:00.000Z") }),
      makeTrade({ id: "bt-3", entryTimestamp: new Date("2024-01-10T00:00:00.000Z") }),
    ];
    // Journal trades (already sorted): Jan 3, Jan 7 — interleaved with the backtest trades above.
    const journalTrades = [
      makeTrade({ id: "jt-1", source: "JOURNAL", entryTimestamp: new Date("2024-01-03T00:00:00.000Z") }),
      makeTrade({ id: "jt-2", source: "JOURNAL", entryTimestamp: new Date("2024-01-07T00:00:00.000Z") }),
    ];

    const merged = mergeNormalizedTradesChronologically(backtestTrades, journalTrades);

    expect(merged.map((trade) => trade.id)).toEqual(["bt-1", "jt-1", "bt-2", "jt-2", "bt-3"]);
    // Every entryTimestamp is non-decreasing.
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]!.entryTimestamp.getTime()).toBeGreaterThanOrEqual(
        merged[i - 1]!.entryTimestamp.getTime(),
      );
    }
  });

  it("returns an empty array when both sources are empty", () => {
    expect(mergeNormalizedTradesChronologically([], [])).toEqual([]);
  });

  it("returns the other list unchanged when one source is empty", () => {
    const journalTrades = [
      makeTrade({ id: "jt-1", source: "JOURNAL", entryTimestamp: new Date("2024-01-03T00:00:00.000Z") }),
    ];
    expect(mergeNormalizedTradesChronologically([], journalTrades)).toEqual(journalTrades);
  });
});
