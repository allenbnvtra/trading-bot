import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  GENERATE_POST_TRADE_SCREENSHOT_JOB,
  GENERATE_PRE_TRADE_SCREENSHOT_JOB,
  RENDER_READY_TIMEOUT_MS,
  SCREENSHOT_QUEUE,
  SCREENSHOT_RENDER_HEIGHT,
  SCREENSHOT_RENDER_WIDTH,
  type ScreenshotGenerationJobPayload,
} from "@trading-copilot/shared-types";
import { tradeScreenshotsRepository } from "@trading-copilot/database";
import { buildScreenshotStorageKey, type ScreenshotStorage } from "@trading-copilot/screenshot-storage";
import { BrowserManager } from "./browser-manager";
import { SCREENSHOT_STORAGE_TOKEN } from "./screenshot-storage.provider";

const DASHBOARD_BASE_URL = process.env.DASHBOARD_INTERNAL_BASE_URL ?? "http://localhost:3000";

interface RenderResult {
  state: "ready" | "error";
  code?: string;
  message?: string;
}

/** Internal, non-BullMQ-visible carrier for a specific failure code/message pair, thrown from within the try block below and caught by the single outer catch that owns every call to markScreenshotFailed. */
interface ScreenshotFailure {
  failureCode: string;
  failureMessage: string;
}

function isScreenshotFailure(err: unknown): err is ScreenshotFailure {
  return typeof err === "object" && err !== null && "failureCode" in err && "failureMessage" in err;
}

/**
 * See docs/screenshot-design.md "Playwright screenshot worker". Every
 * failure path marks the TradeScreenshot row FAILED (auditable - never a
 * silently-lost job) and rethrows so BullMQ records the job as failed too;
 * SCREENSHOT_QUEUE is configured with attempts: 1, so this never becomes a
 * retry storm (docs' "do not retry indefinitely").
 */
@Processor(SCREENSHOT_QUEUE)
@Injectable()
export class ScreenshotGenerationProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(ScreenshotGenerationProcessor.name);

  constructor(
    private readonly browserManager: BrowserManager,
    @Inject(SCREENSHOT_STORAGE_TOKEN) private readonly storage: ScreenshotStorage,
  ) {
    super();
  }

  async process(job: Job<ScreenshotGenerationJobPayload>): Promise<void> {
    const { screenshotId } = job.data;
    const screenshot = await tradeScreenshotsRepository.getScreenshot(screenshotId);

    if (!screenshot) {
      throw new Error(`TradeScreenshot ${screenshotId} not found`);
    }
    if (screenshot.status === "READY") {
      this.logger.log(`TradeScreenshot ${screenshotId} already READY; idempotent no-op`);
      return;
    }

    try {
      await tradeScreenshotsRepository.markScreenshotGenerating(screenshotId);

      const renderUrl = this.buildRenderUrl(job.name, screenshot);
      const page = await this.browserManager.getPage();

      try {
        await page.setViewportSize({ width: SCREENSHOT_RENDER_WIDTH, height: SCREENSHOT_RENDER_HEIGHT });

        try {
          await page.goto(renderUrl, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () =>
              document.body.dataset.renderState === "ready" ||
              document.body.dataset.renderState === "error",
            undefined,
            { timeout: RENDER_READY_TIMEOUT_MS },
          );
        } catch {
          throw {
            failureCode: "RENDER_TIMEOUT",
            failureMessage: `No render-ready signal within ${RENDER_READY_TIMEOUT_MS}ms`,
          } satisfies ScreenshotFailure;
        }

        const result = await page.evaluate<RenderResult>(() => {
          const { renderState, renderErrorCode, renderErrorMessage } = document.body.dataset;
          if (renderState === "error") {
            return { state: "error", code: renderErrorCode, message: renderErrorMessage };
          }
          return { state: "ready" };
        });

        if (result.state === "error") {
          throw {
            failureCode: result.code ?? "RENDER_ERROR",
            failureMessage: result.message ?? "Unknown render error",
          } satisfies ScreenshotFailure;
        }

        let buffer: Buffer;
        try {
          buffer = await page.screenshot();
        } catch (err) {
          throw { failureCode: "SCREENSHOT_CAPTURE_FAILED", failureMessage: String(err) } satisfies ScreenshotFailure;
        }

        const storageKey = buildScreenshotStorageKey({
          setupId: screenshot.setupId,
          tradeId: screenshot.tradeId,
          tradeSource: screenshot.tradeSource,
          type: screenshot.type,
          chartConfigVersion: screenshot.chartConfigVersion,
        });

        try {
          await this.storage.save(storageKey, buffer, "image/png");
        } catch (err) {
          throw { failureCode: "STORAGE_WRITE_FAILED", failureMessage: String(err) } satisfies ScreenshotFailure;
        }

        await tradeScreenshotsRepository.markScreenshotReady(screenshotId, {
          storageProvider: "LOCAL_DISK",
          storageKey,
          mimeType: "image/png",
          width: SCREENSHOT_RENDER_WIDTH,
          height: SCREENSHOT_RENDER_HEIGHT,
          renderedAt: new Date(),
        });
      } finally {
        await page.close();
      }
    } catch (err) {
      const { failureCode, failureMessage } = isScreenshotFailure(err)
        ? err
        : { failureCode: "UNKNOWN_ERROR", failureMessage: String(err) };

      await tradeScreenshotsRepository.markScreenshotFailed(screenshotId, { failureCode, failureMessage });
      throw new Error(`Screenshot ${screenshotId} generation failed: ${failureCode} - ${failureMessage}`);
    }
  }

  private buildRenderUrl(
    jobName: string,
    screenshot: { setupId: string | null; tradeId: string | null },
  ): string {
    if (jobName === GENERATE_PRE_TRADE_SCREENSHOT_JOB) {
      return `${DASHBOARD_BASE_URL}/internal/render/setup/${screenshot.setupId}`;
    }
    if (jobName === GENERATE_POST_TRADE_SCREENSHOT_JOB) {
      return `${DASHBOARD_BASE_URL}/internal/render/trade/${screenshot.tradeId}`;
    }
    throw new Error(`Unknown screenshot job name: ${jobName}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.browserManager.close();
  }
}
