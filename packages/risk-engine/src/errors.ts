/**
 * Thrown by every risk-engine function on invalid input (NaN, Infinity,
 * negative risk, zero/negative stop distance, zero/negative tick size, a
 * price on the wrong side of entry, etc). Callers (the backtester, the API)
 * must catch this rather than let bad input silently produce NaN/Infinity
 * financial numbers.
 */
export class RiskEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskEngineError";
    Object.setPrototypeOf(this, RiskEngineError.prototype);
  }
}
