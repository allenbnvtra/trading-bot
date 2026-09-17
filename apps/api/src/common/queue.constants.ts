/**
 * BullMQ contract for the "run a backtest in the background" job, shared
 * (by convention, not by import — apps/api and apps/worker are separate
 * deployables) with apps/worker/src/backtest-run/backtest-run.constants.ts.
 * Keep both files identical if this contract ever changes.
 *
 * The payload is intentionally minimal: the worker re-fetches everything
 * else (instrument, strategy version, candles, assumptions) from Postgres
 * via backtestId, so Postgres stays the single source of truth and the job
 * payload can never go stale relative to the database.
 */
export const BACKTEST_RUN_QUEUE = "backtest-run";
export const BACKTEST_RUN_JOB = "run";

export interface BacktestRunJobPayload {
  backtestId: string;
}
