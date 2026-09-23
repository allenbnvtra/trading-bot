import { InjectQueue } from "@nestjs/bullmq";
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  GENERATE_POST_TRADE_SCREENSHOT_JOB,
  GENERATE_PRE_TRADE_SCREENSHOT_JOB,
  CHART_CONFIG_VERSION,
  SCREENSHOT_QUEUE,
  type ScreenshotGenerationJobPayload,
} from "@trading-copilot/shared-types";
import { journalTradesRepository, setupsRepository, tradeScreenshotsRepository } from "@trading-copilot/database";
import type { TradeScreenshot } from "@trading-copilot/trading-domain";

/**
 * Consumed directly by SetupService/JournalTradeService (best-effort
 * generation triggers on the READY transition and on trade close - see
 * their doc comments) as well as reachable over HTTP via SetupController/
 * JournalTradeController. requestOrRetryScreenshot on
 * tradeScreenshotsRepository is the idempotency boundary: this service never
 * duplicates that logic, it only decides whether a queue job needs enqueuing
 * on top of the (possibly pre-existing) row it returns.
 */
@Injectable()
export class ScreenshotService {
  private readonly logger = new Logger(ScreenshotService.name);

  constructor(
    @InjectQueue(SCREENSHOT_QUEUE) private readonly screenshotQueue: Queue<ScreenshotGenerationJobPayload>,
  ) {}

  async requestPreTradeScreenshot(setupId: string): Promise<TradeScreenshot> {
    const setup = await setupsRepository.getSetup(setupId);
    if (!setup) throw new NotFoundException(`Setup ${setupId} not found`);

    const { screenshot, alreadyInFlight } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
      setupId,
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: setup.marketSnapshotId,
      chartConfigVersion: CHART_CONFIG_VERSION,
    });

    await this.enqueueIfNeeded(GENERATE_PRE_TRADE_SCREENSHOT_JOB, screenshot, alreadyInFlight);
    return screenshot;
  }

  async requestPostTradeScreenshot(tradeId: string): Promise<TradeScreenshot> {
    const trade = await journalTradesRepository.getJournalTrade(tradeId);
    if (!trade) throw new NotFoundException(`JournalTrade ${tradeId} not found`);
    if (trade.status !== "CLOSED") {
      // A state conflict, not a "not found" - matches this codebase's other
      // lifecycle-state rejections (e.g. SetupTransitionError/
      // JournalTradeStateError -> 409 via DomainErrorFilter).
      throw new ConflictException(
        `JournalTrade ${tradeId} is not CLOSED yet — no POST_TRADE screenshot to generate`,
      );
    }
    if (trade.setupId === null) {
      // No Setup lineage means no MarketSnapshot, which means no timeframe
      // to render a chart from - "unknown stays unknown," never fabricated
      // (see docs/screenshot-design.md). This is a real, permanent
      // precondition failure for this trade, not a transient one, so 422
      // rather than 409/404. The automatic close-trigger in
      // journal-trade.service.ts never calls this in the first place for a
      // setupId: null trade; this guard is what protects a caller hitting
      // the manual POST endpoint directly for the same trade.
      throw new UnprocessableEntityException(
        `JournalTrade ${tradeId} has no Setup lineage (setupId is null) — no chart context available to render a POST_TRADE screenshot from`,
      );
    }

    const { screenshot, alreadyInFlight } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
      setupId: null,
      tradeId,
      tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE",
      marketSnapshotId: null,
      chartConfigVersion: CHART_CONFIG_VERSION,
    });

    await this.enqueueIfNeeded(GENERATE_POST_TRADE_SCREENSHOT_JOB, screenshot, alreadyInFlight);
    return screenshot;
  }

  /**
   * Enqueuing is attempted not just for a brand-new row (!alreadyInFlight)
   * but also whenever the existing row is still REQUESTED:
   * requestOrRetryScreenshot's own transaction creates/resets the row
   * before this method ever gets a chance to enqueue, so a crash/Redis
   * outage right after that (original creation) or a genuine render
   * failure (FAILED -> REQUESTED reset) both need this method to actually
   * get a job queued, not just infer from the DB row alone that one
   * exists. Deliberately does NOT re-attempt once the row has moved past
   * REQUESTED (GENERATING or READY) - those never touch BullMQ at all
   * here; see docs/screenshot-design.md's known-limitations note for why a
   * row stuck at GENERATING is a different, harder case and out of scope.
   * The REQUESTED-only gate stays a plain DB-status check (cheap, no Redis
   * round trip) - it's only the decision of *how* to get a job queued for
   * a REQUESTED row that must be driven by BullMQ's real job state, via
   * enqueueJobIfNeeded below.
   */
  private async enqueueIfNeeded(
    jobName: string,
    screenshot: TradeScreenshot,
    alreadyInFlight: boolean,
  ): Promise<void> {
    if (alreadyInFlight && screenshot.status !== "REQUESTED") {
      return;
    }
    await enqueueJobIfNeeded(this.screenshotQueue, jobName, screenshot.id, this.logger);
  }

  listForSetup(setupId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForSetup(setupId);
  }

  listForTrade(tradeId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForTrade(tradeId, "JOURNAL_TRADE");
  }
}

/**
 * Job-state-aware enqueue for one screenshotId, mirroring
 * WebhookReconciliationProcessor.reconcileEvent exactly (see
 * apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts)
 * and for the identical reason: BullMQ's jobId-based dedup only prevents a
 * duplicate `add()` while a job with that id is still retained under *any*
 * state BullMQ keeps a hash for - and since SCREENSHOT_QUEUE sets neither
 * `removeOnComplete` nor `removeOnFail`, that includes `failed`, which is
 * retained forever, not just `waiting`/`active`/`delayed`. A blind `add()`
 * therefore permanently no-ops once a job has genuinely failed (a real
 * render error, attempts: 1 means no automatic BullMQ retry) - this is
 * exactly the case where `requestOrRetryScreenshot` resets a FAILED row
 * back to REQUESTED so ScreenshotService can re-attempt it, and a blind
 * `add()` would silently return the stale failed job instead of creating a
 * fresh one, leaving the row stuck REQUESTED forever with every future
 * retry hitting the identical collision. So before adding anything, this
 * checks the job's actual state via `queue.getJob(screenshotId)`:
 *  - no job found -> `add()` (the brand-new-screenshot case, unchanged).
 *  - `failed` -> `job.retry("failed")`, an atomic BullMQ operation that
 *    only moves a job that is genuinely still in the failed set back to
 *    waiting - this is what actually fixes the stuck-row bug.
 *  - `completed` -> logged as a warning and skipped. A completed job
 *    implies the row should already be READY, not still needing
 *    generation; seeing this combination means something else is wrong (a
 *    bug elsewhere), so it's surfaced loudly rather than silently worked
 *    around. Callers only reach this function for a row still REQUESTED
 *    (see ScreenshotService#enqueueIfNeeded's own gate), so this should not
 *    normally occur.
 *  - `waiting`/`active`/`delayed` -> skip. A job for this screenshot is
 *    already going to run (or is running); this is the ordinary in-flight
 *    case BullMQ's dedup was always meant to short-circuit.
 *
 * Exported standalone (not a private ScreenshotService method) so it can be
 * exercised against a real BullMQ Queue/Redis without needing a full
 * ScreenshotService + Postgres setup - see screenshot.service.redis.test.ts,
 * which proves the failed -> retry path this function exists for against
 * real BullMQ, not a mock of it.
 */
export async function enqueueJobIfNeeded(
  queue: Queue<ScreenshotGenerationJobPayload>,
  jobName: string,
  screenshotId: string,
  logger: Logger,
): Promise<void> {
  const existingJob = await queue.getJob(screenshotId);

  if (!existingJob) {
    await queue.add(jobName, { screenshotId }, { jobId: screenshotId });
    return;
  }

  const state = await existingJob.getState();

  if (state === "failed") {
    await existingJob.retry("failed");
    return;
  }

  if (state === "completed") {
    logger.warn(
      `TradeScreenshot ${screenshotId} has a completed BullMQ job while its row is still REQUESTED - skipping re-enqueue; this indicates a bug elsewhere.`,
    );
    return;
  }

  // waiting/active/delayed - already in flight, nothing to do.
}
