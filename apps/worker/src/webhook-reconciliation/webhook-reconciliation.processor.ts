import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import {
  TRADINGVIEW_WEBHOOK_JOB,
  TRADINGVIEW_WEBHOOK_QUEUE,
  WEBHOOK_RECONCILIATION_JOB,
  WEBHOOK_RECONCILIATION_JOB_ID,
  WEBHOOK_RECONCILIATION_QUEUE,
  type TradingViewWebhookJobPayload,
} from "@trading-copilot/shared-types";
import { inboundWebhookEventsRepository } from "@trading-copilot/database";

const STALE_THRESHOLD_MINUTES = process.env.WEBHOOK_RECONCILIATION_STALE_THRESHOLD_MINUTES
  ? Number(process.env.WEBHOOK_RECONCILIATION_STALE_THRESHOLD_MINUTES)
  : 5;
const INTERVAL_MINUTES = process.env.WEBHOOK_RECONCILIATION_INTERVAL_MINUTES
  ? Number(process.env.WEBHOOK_RECONCILIATION_INTERVAL_MINUTES)
  : 5;

/**
 * Sweeps for InboundWebhookEvents stuck at RECEIVED/QUEUED past a stale
 * threshold and re-enqueues their processing job. See
 * findStaleInboundWebhookEvents's doc comment for the full safety
 * mechanism: the re-enqueue below passes `jobId: event.id`, the exact same
 * id `tradingview-webhook.service.ts` uses for the original enqueue, so
 * BullMQ's own jobId-based dedup guarantees at most one job for a given
 * event can ever be waiting/active at a time — this is what actually
 * prevents two workers from concurrently reading `processingStatus` before
 * either writes `PROCESSING` (a TOCTOU race the DB unique constraint alone
 * doesn't close, since it only guards `Setup` creation, not the
 * `InboundWebhookEvent` audit row). This never touches Setup creation
 * directly — it only ever re-triggers the same processing path a fresh
 * delivery would take.
 */
@Processor(WEBHOOK_RECONCILIATION_QUEUE)
export class WebhookReconciliationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(WebhookReconciliationProcessor.name);

  constructor(
    @InjectQueue(WEBHOOK_RECONCILIATION_QUEUE) private readonly reconciliationQueue: Queue,
    @InjectQueue(TRADINGVIEW_WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue<TradingViewWebhookJobPayload>,
  ) {
    super();
  }

  /**
   * Registers the repeatable sweep on module init. `queue.add(name, data, {
   * repeat, jobId })` — the pattern used elsewhere for one-off delayed jobs
   * (e.g. setup-expiration.processor.ts) — no longer exists on this
   * installed BullMQ version's `JobsOptions` (`repeat` moved out of
   * `add()`'s options entirely); the equivalent, intentionally-idempotent
   * primitive is `Queue.upsertJobScheduler`, keyed by a fixed
   * `jobSchedulerId` (WEBHOOK_RECONCILIATION_JOB_ID). BullMQ upserts the
   * scheduler by that id, so calling this on every worker restart is safe —
   * it updates the existing schedule in place rather than creating a
   * second, duplicate one.
   */
  async onModuleInit(): Promise<void> {
    await this.reconciliationQueue.upsertJobScheduler(
      WEBHOOK_RECONCILIATION_JOB_ID,
      { every: INTERVAL_MINUTES * 60_000 },
      { name: WEBHOOK_RECONCILIATION_JOB },
    );
  }

  async process(_job: Job): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60_000);
    const stale = await inboundWebhookEventsRepository.findStaleInboundWebhookEvents(cutoff);

    if (stale.length === 0) {
      return;
    }

    this.logger.warn(
      `Reconciling ${stale.length} stale InboundWebhookEvent(s) stuck at RECEIVED/QUEUED past ${STALE_THRESHOLD_MINUTES}m`,
    );

    for (const event of stale) {
      // jobId: event.id must match the id used at the original enqueue site
      // (tradingview-webhook.service.ts's ingestWebhook) — see this
      // processor's class doc comment for why that shared id is what makes
      // this re-enqueue race-free, not just "idempotent-safe."
      await this.webhookQueue.add(
        TRADINGVIEW_WEBHOOK_JOB,
        { inboundWebhookEventId: event.id },
        { jobId: event.id },
      );
    }
  }
}
