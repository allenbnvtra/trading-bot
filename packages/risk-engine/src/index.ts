import Decimal from "decimal.js";
import type { Direction } from "@trading-copilot/shared-types";
import { RiskEngineError } from "./errors";
import { assertFiniteDecimal, assertNonNegativeDecimal, assertPositiveDecimal } from "./validation";

export { RiskEngineError };

/**
 * Deterministic, pure, side-effect-free risk math. No dependency on the
 * database or NestJS. Every function throws RiskEngineError on invalid
 * input rather than silently coercing it (see CLAUDE.md "Financial rules").
 */

/** Absolute distance in points between entry and stop. Never zero. */
export function calculateStopDistancePoints(entry: Decimal, stop: Decimal): Decimal {
  assertFiniteDecimal(entry, "entry");
  assertFiniteDecimal(stop, "stop");

  const distance = entry.minus(stop).abs();
  if (distance.isZero()) {
    throw new RiskEngineError(
      "stop distance is zero: entry and stop must not be equal (division by a zero stop distance is undefined)",
    );
  }
  return distance;
}

/** Converts a points distance into a ticks distance for a given tick size. */
export function calculateStopDistanceTicks(stopDistancePoints: Decimal, tickSize: Decimal): Decimal {
  assertPositiveDecimal(stopDistancePoints, "stopDistancePoints");
  assertPositiveDecimal(tickSize, "tickSize");

  return stopDistancePoints.dividedBy(tickSize);
}

/** Dollar amount the account is willing to risk on a single trade. */
export function calculateRiskBudget(accountEquity: Decimal, riskPercentage: Decimal): Decimal {
  assertPositiveDecimal(accountEquity, "accountEquity");
  assertFiniteDecimal(riskPercentage, "riskPercentage");
  if (riskPercentage.isNegative()) {
    throw new RiskEngineError("riskPercentage must not be negative");
  }

  return accountEquity.times(riskPercentage.dividedBy(100));
}

/**
 * Dollar risk of holding a single contract from entry to stop, including
 * commission and an estimated slippage cost. Must be strictly positive:
 * a non-positive result means the stop/commission/slippage inputs cannot
 * define a real risk, and callers must not divide a risk budget by it.
 */
export function calculateRiskPerContract(
  stopDistancePoints: Decimal,
  pointValue: Decimal,
  commissionPerContract: Decimal,
  estimatedSlippageCost: Decimal,
): Decimal {
  assertPositiveDecimal(stopDistancePoints, "stopDistancePoints");
  assertPositiveDecimal(pointValue, "pointValue");
  assertNonNegativeDecimal(commissionPerContract, "commissionPerContract");
  assertNonNegativeDecimal(estimatedSlippageCost, "estimatedSlippageCost");

  const riskPerContract = stopDistancePoints
    .times(pointValue)
    .plus(commissionPerContract)
    .plus(estimatedSlippageCost);

  if (riskPerContract.lessThanOrEqualTo(0)) {
    throw new RiskEngineError("riskPerContract must be greater than zero");
  }
  return riskPerContract;
}

/**
 * Whole-contract position size that fits within the risk budget. A floored
 * result of 0 is NOT an error — it means the account cannot afford even one
 * contract at this risk percentage/stop distance. Callers (the backtester)
 * must handle 0 by skipping the trade, not by treating it as a failure.
 */
export function calculatePositionSize(riskBudget: Decimal, riskPerContract: Decimal): number {
  assertNonNegativeDecimal(riskBudget, "riskBudget");
  assertPositiveDecimal(riskPerContract, "riskPerContract");

  return riskBudget.dividedBy(riskPerContract).floor().toNumber();
}

/**
 * Sign-aware reward:risk ratio. Works for both LONG (target > entry > stop)
 * and SHORT (target < entry < stop) because both distances are taken with
 * the same signed convention (relative to entry) and their signs cancel.
 */
export function calculateRiskReward(entry: Decimal, stop: Decimal, target: Decimal): Decimal {
  assertFiniteDecimal(entry, "entry");
  assertFiniteDecimal(stop, "stop");
  assertFiniteDecimal(target, "target");

  const riskDistance = entry.minus(stop);
  if (riskDistance.isZero()) {
    throw new RiskEngineError("risk distance is zero: entry and stop must not be equal");
  }

  const rewardDistance = target.minus(entry);
  const ratio = rewardDistance.dividedBy(riskDistance);

  if (ratio.lessThanOrEqualTo(0)) {
    throw new RiskEngineError(
      "target is on the wrong side of entry for a positive reward given this stop's direction",
    );
  }
  return ratio;
}

/**
 * Realized gross P&L for a closed position. Mirrors the formula used
 * internally by packages/backtester's engine (kept as a small, separately
 * tested public function here so callers outside the backtester — e.g. the
 * Milestone 2 journal trade close flow — never reimplement this arithmetic
 * themselves; see CLAUDE.md "financial calculations are never independently
 * produced in a controller").
 */
export function calculateGrossPnl(
  entryPrice: Decimal,
  exitPrice: Decimal,
  quantity: number,
  pointValue: Decimal,
  direction: Direction,
): Decimal {
  assertFiniteDecimal(entryPrice, "entryPrice");
  assertFiniteDecimal(exitPrice, "exitPrice");
  assertPositiveDecimal(pointValue, "pointValue");
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RiskEngineError("quantity must be a positive integer");
  }

  const priceDelta = direction === "LONG" ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);
  return priceDelta.times(pointValue).times(quantity);
}

/** Gross P&L minus fees. Fees must be non-negative (a fee cannot be a rebate here). */
export function calculateNetPnl(grossPnl: Decimal, fees: Decimal): Decimal {
  assertFiniteDecimal(grossPnl, "grossPnl");
  assertNonNegativeDecimal(fees, "fees");

  return grossPnl.minus(fees);
}

/**
 * Net P&L expressed as a multiple of the dollar risk actually taken.
 * riskAmount must be strictly positive — a trade with zero planned risk
 * cannot produce a meaningful R multiple.
 */
export function calculateRMultiple(netPnl: Decimal, riskAmount: Decimal): Decimal {
  assertFiniteDecimal(netPnl, "netPnl");
  assertPositiveDecimal(riskAmount, "riskAmount");

  return netPnl.dividedBy(riskAmount);
}

export interface ExcursionCandle {
  high: Decimal;
  low: Decimal;
}

/**
 * Maximum favorable/adverse excursion across a candle range, in points.
 * Mirrors packages/backtester's engine.ts walkTradeForward loop exactly
 * (same per-candle favorable/adverse formula) so a manually-closed
 * JournalTrade's MFE/MAE is computed identically to a BacktestTrade's,
 * rather than by a second, potentially-diverging implementation. Never
 * negative — a candle range that never moves favorably (or adversely)
 * yields 0 for that side, not a negative number. Callers pass the candle
 * range from entry through (and including) exit, matching how the
 * backtester walks candles.
 */
export function calculateExcursions(
  candles: ExcursionCandle[],
  entryPrice: Decimal,
  direction: Direction,
): { mfe: Decimal; mae: Decimal } {
  assertFiniteDecimal(entryPrice, "entryPrice");
  if (candles.length === 0) {
    throw new RiskEngineError("candles must not be empty");
  }

  let mfe = new Decimal(0);
  let mae = new Decimal(0);

  for (const candle of candles) {
    assertFiniteDecimal(candle.high, "candle.high");
    assertFiniteDecimal(candle.low, "candle.low");

    const favorable = direction === "LONG" ? candle.high.minus(entryPrice) : entryPrice.minus(candle.low);
    const adverse = direction === "LONG" ? entryPrice.minus(candle.low) : candle.high.minus(entryPrice);

    if (favorable.greaterThan(mfe)) mfe = favorable;
    if (adverse.greaterThan(mae)) mae = adverse;
  }

  return { mfe, mae };
}
