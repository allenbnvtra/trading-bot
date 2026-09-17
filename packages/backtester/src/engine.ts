import Decimal from "decimal.js";
import type { TradeExitReason } from "@trading-copilot/shared-types";
import type { BacktestTrade, Candle, Instrument, StrategyVersion } from "@trading-copilot/trading-domain";
import {
  STRATEGY_REGISTRY,
  type EmaTrendPullbackParameters,
  type StrategyKey,
  type StrategySignal,
} from "@trading-copilot/strategy-engine";
import {
  calculatePositionSize,
  calculateRiskBudget,
  calculateRiskPerContract,
  calculateStopDistancePoints,
} from "@trading-copilot/risk-engine";
import { BacktesterError } from "./errors";

/**
 * See docs/backtesting-assumptions.md for the prose version of every
 * assumption implemented in this file. This module is the source of truth;
 * that doc must be kept in sync whenever behavior here changes.
 */

export interface BacktestRunInput {
  /**
   * Which strategy implementation to resolve out of STRATEGY_REGISTRY. This
   * package has no database dependency, so it cannot look up
   * `strategyVersion.strategyId -> Strategy.key` itself — the caller (the
   * worker, which does have DB access) resolves the key and passes it here
   * explicitly, alongside the already-validated strategyVersion.
   */
  strategyKey: StrategyKey;
  instrument: Instrument;
  /**
   * Single timeframe, single instrument, MUST be strictly increasing by
   * timestamp. runBacktest throws BacktesterError on duplicate or
   * out-of-order candles rather than silently producing wrong results.
   */
  candles: Candle[];
  strategyVersion: StrategyVersion<EmaTrendPullbackParameters>;
  initialBalance: Decimal;
  riskPercentage: Decimal;
  /** Adverse slippage in ticks, applied on both entry and exit fills. */
  slippageTicks: number;
}

export interface BacktestRunResult {
  trades: Array<Omit<BacktestTrade, "id" | "backtestId">>;
  /**
   * Signals where the computed position size floored to 0 (the account
   * cannot afford even 1 contract at this risk %/stop distance). These are
   * intentionally not persisted as trades, but are counted here for
   * transparency instead of silently vanishing.
   */
  skippedSignalCount: number;
}

function assertCandlesStrictlyIncreasing(candles: Candle[]): void {
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1] as Candle;
    const current = candles[i] as Candle;
    if (current.timestamp.getTime() <= previous.timestamp.getTime()) {
      throw new BacktesterError(
        `candles must be strictly increasing by timestamp: candle at index ${i} ` +
          `(${current.timestamp.toISOString()}) is not strictly after index ${i - 1} ` +
          `(${previous.timestamp.toISOString()}). This usually indicates duplicate or ` +
          "out-of-order candles in the input.",
      );
    }
  }
}

interface OpenTradePlan {
  signal: StrategySignal;
  entryIndex: number;
  entryPrice: Decimal;
  stopPrice: Decimal;
  targetPrice: Decimal;
  quantity: number;
  riskPerContract: Decimal;
}

/**
 * Runs the given strategy version over the given candles and produces the
 * resulting trades and metrics inputs. Pure function of its input: no
 * Math.random(), no wall-clock reads, so calling it twice on identical
 * input always produces byte-identical output.
 */
export function runBacktest(input: BacktestRunInput): BacktestRunResult {
  const { instrument, candles, strategyVersion, initialBalance, riskPercentage, slippageTicks } =
    input;

  if (!Number.isInteger(slippageTicks) || slippageTicks < 0) {
    throw new BacktesterError("slippageTicks must be a non-negative integer");
  }

  assertCandlesStrictlyIncreasing(candles);

  const strategy = STRATEGY_REGISTRY[input.strategyKey];
  const signals = strategy.evaluate(candles, strategyVersion.parameters);

  const slippageAmount = new Decimal(slippageTicks).times(instrument.tickSize);
  const estimatedSlippageCost = slippageAmount.times(instrument.pointValue);

  const trades: Array<Omit<BacktestTrade, "id" | "backtestId">> = [];
  let skippedSignalCount = 0;

  // A new signal is only eligible once the previous trade has fully closed:
  // signals whose index is <= the prior trade's exit index would require
  // entering (index+1) at or before that exit candle, overlapping the
  // still-open position. See docs/backtesting-assumptions.md "one position
  // at a time".
  let blockedUpToIndex = -1;

  for (const signal of signals) {
    if (signal.index <= blockedUpToIndex) {
      continue;
    }

    const entryIndex = signal.index + 1;
    if (entryIndex >= candles.length) {
      // Signal fired on the last available candle: there is no next-bar
      // open to enter on, so the signal is dropped (not counted as
      // "skipped" — that term is reserved for the zero-size case below).
      continue;
    }

    const plan = planEntry(
      signal,
      entryIndex,
      candles,
      slippageAmount,
      strategyVersion.parameters,
    );

    const riskBudget = calculateRiskBudget(initialBalance, riskPercentage);
    const riskPerContract = calculateRiskPerContract(
      plan.stopDistancePoints,
      instrument.pointValue,
      instrument.commissionPerContract,
      estimatedSlippageCost,
    );
    const quantity = calculatePositionSize(riskBudget, riskPerContract);

    if (quantity === 0) {
      skippedSignalCount += 1;
      continue;
    }

    const openPlan: OpenTradePlan = {
      signal,
      entryIndex,
      entryPrice: plan.entryPrice,
      stopPrice: plan.stopPrice,
      targetPrice: plan.targetPrice,
      quantity,
      riskPerContract,
    };

    const trade = walkTradeForward(openPlan, candles, instrument, slippageAmount, strategyVersion);
    trades.push(trade.trade);
    blockedUpToIndex = trade.exitIndex;
  }

  return { trades, skippedSignalCount };
}

function planEntry(
  signal: StrategySignal,
  entryIndex: number,
  candles: Candle[],
  slippageAmount: Decimal,
  parameters: EmaTrendPullbackParameters,
): {
  entryPrice: Decimal;
  stopPrice: Decimal;
  targetPrice: Decimal;
  stopDistancePoints: Decimal;
} {
  const entryCandle = candles[entryIndex] as Candle;
  const { stopAtrMultiplier, targetAtrMultiplier } = parameters;

  // Entry timing (look-ahead prevention): a signal detected using candle
  // i's close may only be entered at candle i+1's open, adjusted adversely
  // by slippage (LONG fills higher/worse, SHORT fills lower/worse).
  const entryPrice =
    signal.direction === "LONG"
      ? entryCandle.open.plus(slippageAmount)
      : entryCandle.open.minus(slippageAmount);

  // Stop/target distances come from atrAtSignal (known at decision time),
  // not re-derived from the actual (next-bar) entry price. This means
  // realized risk can differ slightly from the ATR-at-signal plan because
  // entry is at next-bar open rather than signal close — intentional and
  // conservative; do not "fix" this by re-deriving stop from signal close.
  const stopDistance = signal.atrAtSignal.times(stopAtrMultiplier);
  const targetDistance = signal.atrAtSignal.times(targetAtrMultiplier);

  const stopPrice =
    signal.direction === "LONG" ? entryPrice.minus(stopDistance) : entryPrice.plus(stopDistance);
  const targetPrice =
    signal.direction === "LONG"
      ? entryPrice.plus(targetDistance)
      : entryPrice.minus(targetDistance);

  const stopDistancePoints = calculateStopDistancePoints(entryPrice, stopPrice);

  return { entryPrice, stopPrice, targetPrice, stopDistancePoints };
}

function walkTradeForward(
  plan: OpenTradePlan,
  candles: Candle[],
  instrument: Instrument,
  slippageAmount: Decimal,
  strategyVersion: StrategyVersion<EmaTrendPullbackParameters>,
): { trade: Omit<BacktestTrade, "id" | "backtestId">; exitIndex: number } {
  const { signal, entryIndex, entryPrice, stopPrice, targetPrice, quantity, riskPerContract } =
    plan;
  const isLong = signal.direction === "LONG";

  let maximumFavorableExcursion = new Decimal(0);
  let maximumAdverseExcursion = new Decimal(0);

  let exitIndex = candles.length - 1;
  let exitPrice = (candles[exitIndex] as Candle).close;
  let exitReason: TradeExitReason = "END_OF_DATA";

  for (let j = entryIndex; j < candles.length; j += 1) {
    const candle = candles[j] as Candle;

    // MFE/MAE: best/worst unrealized move in points, from entry through
    // (and including) the exit candle.
    const favorable = isLong ? candle.high.minus(entryPrice) : entryPrice.minus(candle.low);
    const adverse = isLong ? entryPrice.minus(candle.low) : candle.high.minus(entryPrice);
    if (favorable.greaterThan(maximumFavorableExcursion)) {
      maximumFavorableExcursion = favorable;
    }
    if (adverse.greaterThan(maximumAdverseExcursion)) {
      maximumAdverseExcursion = adverse;
    }

    const stopHit = isLong
      ? candle.low.lessThanOrEqualTo(stopPrice)
      : candle.high.greaterThanOrEqualTo(stopPrice);
    const targetHit = isLong
      ? candle.high.greaterThanOrEqualTo(targetPrice)
      : candle.low.lessThanOrEqualTo(targetPrice);

    if (stopHit && targetHit) {
      // Same-candle ambiguity: intrabar order is unknowable from OHLC
      // alone. Conservative rule: assume the stop was hit first (the
      // worse outcome). Treated identically to a plain STOP exit,
      // including adverse slippage, for consistency with that branch.
      exitIndex = j;
      exitPrice = isLong ? stopPrice.minus(slippageAmount) : stopPrice.plus(slippageAmount);
      exitReason = "SAME_CANDLE_STOP_AND_TARGET";
      break;
    }
    if (stopHit) {
      exitIndex = j;
      // Worse fill beyond the stop by slippage, in the losing direction.
      exitPrice = isLong ? stopPrice.minus(slippageAmount) : stopPrice.plus(slippageAmount);
      exitReason = "STOP";
      break;
    }
    if (targetHit) {
      exitIndex = j;
      // Adverse slippage applied for consistency/conservatism, same as STOP.
      exitPrice = isLong ? targetPrice.minus(slippageAmount) : targetPrice.plus(slippageAmount);
      exitReason = "TARGET";
      break;
    }
    if (j === candles.length - 1) {
      // Ran out of data without hitting stop or target: close at the last
      // candle's close. No slippage — this is an artificial end-of-data
      // close for backtest completeness, not a real fill.
      exitIndex = j;
      exitPrice = candle.close;
      exitReason = "END_OF_DATA";
      break;
    }
  }

  const directionMultiplier = isLong ? 1 : -1;
  const grossPnl = exitPrice
    .minus(entryPrice)
    .times(instrument.pointValue)
    .times(quantity)
    .times(directionMultiplier);
  const fees = instrument.commissionPerContract.times(quantity).times(2);
  const netPnl = grossPnl.minus(fees);
  const riskAmount = riskPerContract.times(quantity);
  const rMultiple = netPnl.dividedBy(riskAmount);

  const signalCandle = candles[signal.index] as Candle;
  const entryCandle = candles[entryIndex] as Candle;
  const exitCandle = candles[exitIndex] as Candle;

  const trade: Omit<BacktestTrade, "id" | "backtestId"> = {
    strategyVersionId: strategyVersion.id,
    instrumentId: instrument.id,
    direction: signal.direction,
    signalTimestamp: signalCandle.timestamp,
    entryTimestamp: entryCandle.timestamp,
    entryPrice,
    stopPrice,
    targetPrice,
    exitTimestamp: exitCandle.timestamp,
    exitPrice,
    entryReason: signal.entryReason,
    exitReason,
    quantity,
    grossPnl,
    fees,
    netPnl,
    riskAmount,
    rMultiple,
    maximumFavorableExcursion,
    maximumAdverseExcursion,
  };

  return { trade, exitIndex };
}
