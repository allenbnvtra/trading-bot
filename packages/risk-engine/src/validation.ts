import Decimal from "decimal.js";
import { RiskEngineError } from "./errors";

/**
 * Rejects NaN, +/-Infinity, and non-Decimal-shaped input. Every risk-engine
 * function calls this on every Decimal argument before doing arithmetic with
 * it, so a bad upstream value fails loudly here instead of silently
 * producing a NaN/Infinity dollar amount downstream.
 */
export function assertFiniteDecimal(value: Decimal, name: string): void {
  // Use Decimal.isDecimal (a structural check) rather than `instanceof`:
  // in a monorepo it's possible for a caller's bundler/test runner to load
  // a second copy of the decimal.js module (e.g. one via a prebuilt dist
  // file, one via on-the-fly TS transform), which would make an otherwise
  // perfectly valid Decimal fail an `instanceof` check against this
  // package's own copy of the Decimal class.
  if (!Decimal.isDecimal(value)) {
    throw new RiskEngineError(`${name} must be a Decimal`);
  }
  if (value.isNaN()) {
    throw new RiskEngineError(`${name} must not be NaN`);
  }
  if (!value.isFinite()) {
    throw new RiskEngineError(`${name} must be finite (not Infinity)`);
  }
}

export function assertPositiveDecimal(value: Decimal, name: string): void {
  assertFiniteDecimal(value, name);
  if (value.lessThanOrEqualTo(0)) {
    throw new RiskEngineError(`${name} must be greater than zero`);
  }
}

export function assertNonNegativeDecimal(value: Decimal, name: string): void {
  assertFiniteDecimal(value, name);
  if (value.isNegative()) {
    throw new RiskEngineError(`${name} must not be negative`);
  }
}
