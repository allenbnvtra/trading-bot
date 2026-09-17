/**
 * BullMQ contract for the "run a backtest in the background" job. Kept
 * identical (by convention) to apps/api/src/common/queue.constants.ts — the
 * two apps are separate deployables and don't share an import, so keep both
 * files in sync if this contract ever changes.
 */
export const BACKTEST_RUN_QUEUE = "backtest-run";
export const BACKTEST_RUN_JOB = "run";

export interface BacktestRunJobPayload {
  backtestId: string;
}
