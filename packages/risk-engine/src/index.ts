import Decimal from "decimal.js";
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
