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
 * mechanism.
 *
 * The re-enqueue is **job-state-aware**, not a blind `add()`. BullMQ's
 * jobId-based dedup (both this sweep and the original enqueue in
 * tradingview-webhook.service.ts pass `jobId: event.id`) only prevents a
 * duplicate `add()` while a job with that id is still retained under
 * *any* state BullMQ keeps a hash for — and since neither queue sets
 * `removeOnComplete`/`removeOnFail`, that includes `failed` and
 * `completed`, which are retained forever, not just `waiting`/`active`/
 * `delayed`. A blind `add()` would therefore permanently no-op for any
 * event whose job already reached `failed` (e.g. attempts exhausted during
 * a Postgres outage): the event would stay RECEIVED/QUEUED forever, since
 * every future sweep's `add()` call would just silently return the
 * existing failed job. So before adding anything, this checks the job's
 * actual state via `queue.getJob(event.id)`:
 *  - no job found -> `add()` (the original safe case, unchanged).
 *  - `failed` -> `job.retry("failed")`, an atomic BullMQ operation that
 *    only moves a job that is genuinely still in the failed set back to
 *    waiting - this introduces no new race.
 *  - `completed` -> logged as a warning and skipped. A completed job
 *    implies the event's `processingStatus` should already have advanced
 *    past RECEIVED/QUEUED; seeing this case means something else is wrong
 *    (a bug elsewhere), so it is surfaced loudly rather than silently
 *    worked around.
 *  - `waiting`/`active`/`delayed` (or any other in-flight-ish state) ->
 *    skip. This is the original safe no-op case: a job for this event is
 *    already going to run, and BullMQ's jobId-based dedup is exactly what
 *    prevents two workers from concurrently reading `processingStatus`
 *    before either writes `PROCESSING` (a TOCTOU race the DB unique
 *    constraint alone doesn't close, since it only guards `Setup`
 *    creation, not the `InboundWebhookEvent` audit row).
 *
 * This never touches Setup creation directly — it only ever re-triggers
 * the same processing path a fresh delivery would take.
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
      await this.reconcileEvent(event.id);
    }
  }

  /**
   * Job-state-aware re-enqueue for one stale event. See this class's doc
   * comment for the full decision table and why a blind `add()` alone is
   * not sufficient.
   */
  private async reconcileEvent(eventId: string): Promise<void> {
    // jobId: eventId must match the id used at the original enqueue site
    // (tradingview-webhook.service.ts's ingestWebhook) — this is what makes
    // getJob(eventId) below find the same job a fresh delivery would have
    // created, and what makes the fallback `add()` race-free rather than
    // just "idempotent-safe."
    const existingJob = await this.webhookQueue.getJob(eventId);

    if (!existingJob) {
      await this.webhookQueue.add(
        TRADINGVIEW_WEBHOOK_JOB,
        { inboundWebhookEventId: eventId },
        { jobId: eventId },
      );
      return;
    }

    const state = await existingJob.getState();

    if (state === "failed") {
      // Atomic: only moves a job that is genuinely still in the failed set
      // back to waiting. Safe even if another sweep or worker is touching
      // this job concurrently, since BullMQ verifies the job is actually in
      // the failed set before moving it.
      await existingJob.retry("failed");
      return;
    }

    if (state === "completed") {
      // A completed job implies processingStatus should already have moved
      // past RECEIVED/QUEUED (the processor marks the event PROCESSED/
      // REJECTED/etc. before its job resolves). Seeing this combination
      // means something else is wrong - surface it loudly rather than
      // silently removing+re-adding a job without understanding why.
      this.logger.warn(
        `InboundWebhookEvent ${eventId} is stuck at RECEIVED/QUEUED but its BullMQ job (id=${existingJob.id}) already completed. This should not happen and points at a bug elsewhere (a completed job should have advanced processingStatus) - skipping automatic recovery for this event.`,
      );
      return;
    }

    // waiting/active/delayed (or any other in-flight-ish state such as
    // prioritized/waiting-children) - a job for this event is already going
    // to run (or is running); this is the original safe no-op case.
  }
}
