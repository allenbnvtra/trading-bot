/** Thrown for invalid backtest input, e.g. non-chronological candles. */
export class BacktesterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktesterError";
    Object.setPrototypeOf(this, BacktesterError.prototype);
  }
}
