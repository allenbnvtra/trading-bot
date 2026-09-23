import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, NotFoundException } from "@nestjs/common";
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

    if (!alreadyInFlight) {
      await this.screenshotQueue.add(GENERATE_PRE_TRADE_SCREENSHOT_JOB, { screenshotId: screenshot.id });
    }
    return screenshot;
  }

  async requestPostTradeScreenshot(tradeId: string): Promise<TradeScreenshot> {
    const trade = await journalTradesRepository.getJournalTrade(tradeId);
    if (!trade) throw new NotFoundException(`JournalTrade ${tradeId} not found`);
    if (trade.status !== "CLOSED") {
      throw new NotFoundException(`JournalTrade ${tradeId} is not CLOSED yet — no POST_TRADE screenshot to generate`);
    }

    const { screenshot, alreadyInFlight } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
      setupId: null,
      tradeId,
      tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE",
      marketSnapshotId: null,
      chartConfigVersion: CHART_CONFIG_VERSION,
    });

    if (!alreadyInFlight) {
      await this.screenshotQueue.add(GENERATE_POST_TRADE_SCREENSHOT_JOB, { screenshotId: screenshot.id });
    }
    return screenshot;
  }

  listForSetup(setupId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForSetup(setupId);
  }

  listForTrade(tradeId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForTrade(tradeId, "JOURNAL_TRADE");
  }
}
