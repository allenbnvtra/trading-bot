import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { SCREENSHOT_QUEUE } from "@trading-copilot/shared-types";
import { ScreenshotController } from "./screenshot.controller";
import { screenshotStorageProvider } from "./screenshot-storage.provider";
import { ScreenshotService } from "./screenshot.service";

/**
 * Registers SCREENSHOT_QUEUE as a producer, mirroring
 * tradingview-webhook.module.ts's split with apps/worker's own separate
 * registration of the same queue name as a consumer (attempts: 1 there -
 * see apps/worker/src/screenshot-generation/screenshot-generation.processor.ts).
 * This is the established, correct pattern in this codebase for a queue
 * that both an API-side producer and a worker-side consumer need their own
 * Queue/Worker instance for - not a duplicate-registration bug.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: SCREENSHOT_QUEUE,
      defaultJobOptions: { attempts: 1 },
    }),
  ],
  controllers: [ScreenshotController],
  providers: [ScreenshotService, screenshotStorageProvider],
  exports: [ScreenshotService],
})
export class ScreenshotModule {}
