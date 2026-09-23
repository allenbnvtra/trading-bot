import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import { strategyDefinitionSchema } from "@trading-copilot/strategy-engine";
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

describe("runBacktest - StrategyDefinition DSL", () => {
  /**
   * DSL fixture verified by actually running it (not eyeballed). Candles
   * 0-4 are closes 10, 11, 9, 8, 13 with high = close + 1, low = close - 1,
   * the same shape strategy-definition.test.ts uses for its EMA_CROSS_ABOVE
   * look-ahead proof:
   *   EMA(2): seed@1 = 10.5, idx2 = 9.5, idx3 = 8.5, idx4 = 11.5
   *   EMA(3): seed@2 = 10, idx3 = 9, idx4 = 11
   *   => fast crosses above slow at index 4 (8.5 <= 9, then 11.5 > 11).
   *   ATR(2): TR = [2, 2, 3, 2, 6]; seed@1 = 2, 2.5, 2.25, atr4 = 4.125
   * Candle 5 is the entry candle (open 14, a gap above the signal close of
   * 13, so "next-bar open" is distinguishable from "signal close"); it
   * touches neither stop nor target. Candle 6 trades through the target.
   *
   * With tickSize 0.25, slippageTicks 1 (slippage 0.25), stop 1 x ATR,
   * target 2 x ATR:
   *   entry  = 14 + 0.25            = 14.25
   *   stop   = 14.25 - 1 x 4.125    = 10.125
   *   target = 14.25 + 2 x 4.125    = 22.5
   *   exit   = 22.5 - 0.25 (adverse slippage on target fill) = 22.25
   * Sizing: riskPerContract = 4.125 x 50 + 2.5 commission + 0.25 x 50
   *   slippage cost = 221.25; budget = 100000 x 1% = 1000;
   *   quantity = floor(1000 / 221.25) = 4.
   * P&L: gross = (22.25 - 14.25) x 50 x 4 = 1600; fees = 2.5 x 4 x 2 = 20;
   *   net = 1580; riskAmount = 221.25 x 4 = 885.
   */
  const DSL_DEFINITION = strategyDefinitionSchema.parse({
    version: "1.0.0",
    direction: "LONG",
    entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 2, slowPeriod: 3 }],
    atrPeriod: 2,
    stopAtrMultiplier: 1,
    targetAtrMultiplier: 2,
  });

  function dslCandles(): Candle[] {
    return [
      ...[10, 11, 9, 8, 13].map((close, i) => makeCandle(i, close, close + 1, close - 1, close)),
      makeCandle(5, 14, 15, 13.5, 14.5),
      makeCandle(6, 18, 23, 17, 22),
    ];
  }

  function dslInput(): BacktestRunInput<"ai-generated-dsl-v1"> {
    return {
      strategyKey: "ai-generated-dsl-v1",
      instrument: makeInstrument(),
      candles: dslCandles(),
      strategyVersion: {
        id: "sv-dsl-1",
        strategyId: "s-dsl",
        version: "1.0.0",
        name: "DSL test",
        description: "test",
        parameters: DSL_DEFINITION,
        status: "DISCOVERED",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        sourceHypothesisId: null,
      },
      initialBalance: D(100000),
      riskPercentage: D(1),
      slippageTicks: 1,
    };
  }

  it("runs an AI-generated-DSL strategy through the same engine as ema-trend-pullback and produces a real trade", () => {
    const result = runBacktest(dslInput());

    expect(result.trades.length).toBe(1);
    expect(result.skippedSignalCount).toBe(0);
    const trade = result.trades[0]!;
    const candles = dslCandles();

    expect(trade.direction).toBe("LONG");
    expect(trade.strategyVersionId).toBe("sv-dsl-1");
    expect(trade.entryReason).toBe("StrategyDefinition v1.0.0: EMA_CROSS_ABOVE");

    // Entry timing: signal on candle 4's close, entered at candle 5's open
    // plus one tick of adverse slippage, never at the signal close (13).
    expect(trade.signalTimestamp).toEqual(candles[4]!.timestamp);
    expect(trade.entryTimestamp).toEqual(candles[5]!.timestamp);
    expect(trade.entryPrice.toString()).toBe("14.25");

    // Stop/target distances are atrAtSignal (4.125) x the definition's
    // multipliers, measured from the actual entry price.
    const atrAtSignal = D("4.125");
    expect(trade.entryPrice.minus(trade.stopPrice).toString()).toBe(
      atrAtSignal.times(DSL_DEFINITION.stopAtrMultiplier).toString(),
    );
    expect(trade.targetPrice.minus(trade.entryPrice).toString()).toBe(
      atrAtSignal.times(DSL_DEFINITION.targetAtrMultiplier).toString(),
    );
    expect(trade.stopPrice.toString()).toBe("10.125");
    expect(trade.targetPrice.toString()).toBe("22.5");

    // Exit on candle 6 at target minus adverse slippage.
    expect(trade.exitReason).toBe("TARGET");
    expect(trade.exitTimestamp).toEqual(candles[6]!.timestamp);
    expect(trade.exitPrice.toString()).toBe("22.25");

    expect(trade.quantity).toBe(4);
    expect(trade.grossPnl.toString()).toBe("1600");
    expect(trade.fees.toString()).toBe("20");
    expect(trade.netPnl.toString()).toBe("1580");
    expect(trade.riskAmount.toString()).toBe("885");
    expect(trade.rMultiple.toString()).toBe(D(1580).dividedBy(885).toString());
    expect(trade.maximumFavorableExcursion.toString()).toBe("8.75");
    expect(trade.maximumAdverseExcursion.toString()).toBe("0.75");
  });

  it("is deterministic: two runs on identical DSL input produce byte-identical trades", () => {
    const first = runBacktest(dslInput());
    const second = runBacktest(dslInput());
    expect(first.trades.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
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
