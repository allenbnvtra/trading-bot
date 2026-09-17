/**
 * BullMQ contract for the "expire a TRADINGVIEW-sourced Setup that was
 * never actioned in time" delayed job (Milestone 3, see
 * docs/tradingview-setup.md "Setup expiration"). Kept in its own file
 * rather than tradingview.ts: setup expiration is a generic Setup
 * lifecycle concern, not part of the TradingView payload/normalization
 * logic that file owns. Both the producer (apps/worker's
 * tradingview-webhook processor, which schedules the delayed job right
 * after creating a Setup) and the consumer (apps/worker's own
 * setup-expiration processor) import this single definition rather than
 * duplicating it.
 */
export const SETUP_EXPIRATION_QUEUE = "setup-expiration";
export const SETUP_EXPIRATION_JOB = "expire";

export interface SetupExpirationJobPayload {
  setupId: string;
}
