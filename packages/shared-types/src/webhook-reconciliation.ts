/**
 * Periodic sweep for the narrow crash window between an InboundWebhookEvent
 * being persisted and its BullMQ processing job being successfully
 * enqueued. See docs/tradingview-setup.md "Known limitations" (now fixed)
 * and apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts.
 */
export const WEBHOOK_RECONCILIATION_QUEUE = "webhook-reconciliation";
export const WEBHOOK_RECONCILIATION_JOB = "reconcile-stale-webhook-events";
/** Fixed id for the repeatable job itself, so re-registering it on every
 * worker restart upserts the same schedule rather than creating a second,
 * duplicate repeatable job in BullMQ/Redis. */
export const WEBHOOK_RECONCILIATION_JOB_ID = "webhook-reconciliation-repeatable";
