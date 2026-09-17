import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import { runBacktest, type BacktestRunInput } from "./engine";
import { BacktesterError } from "./errors";
import {
  BASE_PARAMETERS,
  D,
  buildBaseUptrendCandles,
  makeCandle,
  makeInstrument,
  makeStrategyVersion,
} from "./test-helpers";

/**
 * All scenarios build on the base 5-candle uptrend series (see
 * test-helpers.ts), which fires exactly one LONG signal at index 4 with
 * atrAtSignal = 3.125. With stopAtrMultiplier=1, targetAtrMultiplier=2:
 *   stopDistance = 3.125, targetDistance = 6.25
 * A 6th candle (index 5) is the entry candle (signal index 4 + 1). Its open
 * is set to 110 (a gap up from the signal close of 108) so entry-timing
 * tests can distinguish "entered at next-bar open" from "entered at signal
 * close". With slippageTicks=0: entryPrice=110, stopPrice=106.875,
 * targetPrice=116.25.
 */
function baseInput(overrides: Partial<BacktestRunInput> = {}): BacktestRunInput {
  return {
    strategyKey: "ema-trend-pullback",
    instrument: makeInstrument(),
    candles: buildBaseUptrendCandles(),
    strategyVersion: makeStrategyVersion(BASE_PARAMETERS),
    initialBalance: D(100000),
    riskPercentage: D(1),
    slippageTicks: 0,
    ...overrides,
  };
}

function withEntryCandle(entry: { open: number; high: number; low: number; close: number }): Candle[] {
  return [...buildBaseUptrendCandles(), makeCandle(5, entry.open, entry.high, entry.low, entry.close)];
}

describe("runBacktest — entry timing (look-ahead prevention)", () => {
  it("drops a signal that fires on the last available candle (no next-bar open to enter on)", () => {
    const result = runBacktest(baseInput({ candles: buildBaseUptrendCandles() }));
    expect(result.trades).toHaveLength(0);
    expect(result.skippedSignalCount).toBe(0);
  });

  it("enters at the next candle's open, not the signal candle's close", () => {
    const candles = withEntryCandle({ open: 110, high: 112, low: 106.875, close: 110 });
    const result = runBacktest(baseInput({ candles }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    // Signal candle (index 4) closed at 108; entry candle (index 5) opened
    // at 110 (a gap). entryPrice must be 110, not 108.
    expect(trade.entryPrice.toString()).toBe("110");
    expect(trade.entryTimestamp).toEqual(candles[5]!.timestamp);
    expect(trade.signalTimestamp).toEqual(candles[4]!.timestamp);
  });
});

describe("runBacktest — stop/target execution", () => {
  it("exits on STOP when only the stop is touched", () => {
    const candles = withEntryCandle({ open: 110, high: 112, low: 106.875, close: 110 });
    const result = runBacktest(baseInput({ candles }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe("STOP");
    expect(trade.exitPrice.toString()).toBe("106.875");
    expect(trade.stopPrice.toString()).toBe("106.875");
    expect(trade.targetPrice.toString()).toBe("116.25");
    expect(trade.quantity).toBe(6);
    expect(trade.grossPnl.toString()).toBe("-937.5");
    expect(trade.fees.toString()).toBe("30");
    expect(trade.netPnl.toString()).toBe("-967.5");
  });

  it("exits on TARGET when only the target is touched", () => {
    const candles = withEntryCandle({ open: 110, high: 116.25, low: 109, close: 110 });
    const result = runBacktest(baseInput({ candles }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe("TARGET");
    expect(trade.exitPrice.toString()).toBe("116.25");
    expect(trade.grossPnl.toString()).toBe("1875");
    expect(trade.fees.toString()).toBe("30");
    expect(trade.netPnl.toString()).toBe("1845");
  });

  it("applies the conservative same-candle rule (assume stop hit first) when both are touched in one candle", () => {
    const candles = withEntryCandle({ open: 110, high: 116.25, low: 106.875, close: 110 });
    const result = runBacktest(baseInput({ candles }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe("SAME_CANDLE_STOP_AND_TARGET");
    // Treated identically to a plain STOP exit (including slippage, which
    // is 0 in this fixture, so exitPrice equals stopPrice exactly here).
    expect(trade.exitPrice.toString()).toBe("106.875");
  });

  it("applies slippage to the same-candle exit identically to a plain STOP exit", () => {
    // With slippageTicks=2 (tickSize=0.25 -> slippageAmount=0.5), entry
    // slips from 110 to 110.5, which shifts stopPrice to 107.375 and
    // targetPrice to 116.75. The candle's range must still cross both at
    // those shifted levels for this to exercise the same-candle branch.
    const candles = withEntryCandle({ open: 110, high: 117.5, low: 106.875, close: 110 });
    const result = runBacktest(baseInput({ candles, slippageTicks: 2 }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.entryPrice.toString()).toBe("110.5");
    expect(trade.stopPrice.toString()).toBe("107.375");
    expect(trade.exitReason).toBe("SAME_CANDLE_STOP_AND_TARGET");
    // Worsened downward from stopPrice by slippageAmount: 107.375 - 0.5 = 106.875.
    expect(trade.exitPrice.toString()).toBe("106.875");
  });

  it("closes at the last candle's close with END_OF_DATA when neither stop nor target is hit", () => {
    const candles = withEntryCandle({ open: 110, high: 112, low: 109, close: 111 });
    const result = runBacktest(baseInput({ candles }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe("END_OF_DATA");
    expect(trade.exitPrice.toString()).toBe("111");
    expect(trade.exitTimestamp).toEqual(candles[5]!.timestamp);
  });
});

describe("runBacktest — slippage", () => {
  it("worsens both the entry fill and the stop-exit fill", () => {
    const candles = withEntryCandle({ open: 110, high: 112, low: 107.375, close: 110 });
    const result = runBacktest(baseInput({ candles, slippageTicks: 2 }));

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    // tickSize=0.25, slippageTicks=2 -> slippageAmount=0.5
    expect(trade.entryPrice.toString()).toBe("110.5"); // worse (higher) for a LONG buy
    expect(trade.stopPrice.toString()).toBe("107.375");
    expect(trade.exitReason).toBe("STOP");
    expect(trade.exitPrice.toString()).toBe("106.875"); // worse (lower) for the exit sell
  });
});

describe("runBacktest — commissions", () => {
  it("reduces netPnl relative to grossPnl by the round-turn commission", () => {
    const candles = withEntryCandle({ open: 110, high: 116.25, low: 109, close: 110 });
    const result = runBacktest(baseInput({ candles }));
    const trade = result.trades[0]!;

    // commissionPerContract=2.5, round-turn (entry+exit) = 2.5 * quantity * 2
    expect(trade.quantity).toBe(6);
    expect(trade.fees.toString()).toBe("30");
    expect(trade.netPnl.toString()).toBe(trade.grossPnl.minus(trade.fees).toString());
    expect(trade.fees.greaterThan(0)).toBe(true);
    expect(trade.netPnl.lessThan(trade.grossPnl)).toBe(true);
  });
});

describe("runBacktest — position sizing", () => {
  it("skips a signal (and counts it) when the computed position size floors to 0", () => {
    const candles = withEntryCandle({ open: 110, high: 112, low: 106.875, close: 110 });
    const result = runBacktest(
      baseInput({ candles, initialBalance: D(10), riskPercentage: D(1) }),
    );

    expect(result.trades).toHaveLength(0);
    expect(result.skippedSignalCount).toBe(1);
  });
});

describe("runBacktest — input validation", () => {
  it("throws a clear error on duplicate/out-of-order candle timestamps", () => {
    const candles = buildBaseUptrendCandles();
    const duplicated: Candle[] = [...candles, { ...candles[4]!, id: "dup" }];
    expect(() => runBacktest(baseInput({ candles: duplicated }))).toThrow(BacktesterError);
    expect(() => runBacktest(baseInput({ candles: duplicated }))).toThrow(/strictly increasing/);
  });

  it("throws when slippageTicks is negative", () => {
    expect(() => runBacktest(baseInput({ slippageTicks: -1 }))).toThrow(BacktesterError);
  });
});

describe("runBacktest — determinism", () => {
  it("produces byte-identical output across repeated runs on identical input", () => {
    const input = baseInput({
      candles: withEntryCandle({ open: 110, high: 116.25, low: 109, close: 110 }),
    });
    const first = runBacktest(input);
    const second = runBacktest(input);
    expect(second).toEqual(first);
  });
});

describe("runBacktest — MFE/MAE", () => {
  it("tracks the best and worst unrealized excursion from entry through the exit candle inclusive", () => {
    // Entry at 110. Before hitting target (116.25), the entry candle itself
    // dips to 108 (adverse) then closes without hitting stop/target, then a
    // second candle rallies to 118 before pulling back and hitting target.
    const candles = [
      ...buildBaseUptrendCandles(),
      makeCandle(5, 110, 111, 108, 109), // entry candle: no stop/target hit
      makeCandle(6, 109, 118, 107, 116.25), // touches target this candle
    ];
    const result = runBacktest(baseInput({ candles }));
    const trade = result.trades[0]!;

    // MFE: best favorable move across candles 5-6 = 118 - 110 = 8
    expect(trade.maximumFavorableExcursion.toString()).toBe("8");
    // MAE: worst adverse move across candles 5-6 = 110 - 107 = 3
    expect(trade.maximumAdverseExcursion.toString()).toBe("3");
  });
});
