import { InjectQueue } from "@nestjs/bullmq";
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
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
   * jobId: screenshot.id makes add() a safe no-op whenever a job already
   * exists under that id (BullMQ dedups by jobId across waiting/active/
   * delayed/failed/completed) - the common, healthy case where a job is
   * already in flight for this row. Enqueuing is attempted not just for a
   * brand-new row (!alreadyInFlight) but also whenever the existing row is
   * still REQUESTED: requestOrRetryScreenshot's own transaction creates the
   * row before this method ever gets a chance to enqueue, so a crash/Redis
   * outage between those two steps previously left a REQUESTED row with no
   * job behind it, permanently invisible to every future caller (repository
   * always reports `alreadyInFlight: true` for a REQUESTED row, so
   * `!alreadyInFlight` alone never re-attempts the enqueue). Deliberately
   * does NOT re-attempt once the row has moved past REQUESTED (GENERATING
   * or READY) - see docs/screenshot-design.md's known-limitations note for
   * why a row stuck at GENERATING is a different, harder case and out of
   * scope here.
   */
  private async enqueueIfNeeded(
    jobName: string,
    screenshot: TradeScreenshot,
    alreadyInFlight: boolean,
  ): Promise<void> {
    if (alreadyInFlight && screenshot.status !== "REQUESTED") {
      return;
    }
    await this.screenshotQueue.add(jobName, { screenshotId: screenshot.id }, { jobId: screenshot.id });
  }

  listForSetup(setupId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForSetup(setupId);
  }

  listForTrade(tradeId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForTrade(tradeId, "JOURNAL_TRADE");
  }
}
