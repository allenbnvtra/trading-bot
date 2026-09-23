import type { Provider } from "@nestjs/common";
import { LocalDiskScreenshotStorage, type ScreenshotStorage } from "@trading-copilot/screenshot-storage";

/**
 * Mirrors apps/worker/src/screenshot-generation/screenshot-storage.provider.ts
 * exactly (same token value, same factory, same env var). apps/api and
 * apps/worker are separate NestJS processes with separate DI containers, so
 * this provider can't be shared as a single instance across them - this is
 * apps/api's own registration, reading the same SCREENSHOT_STORAGE_ROOT env
 * var so both processes resolve to the same on-disk root. This is what
 * backs GET /screenshots/:id/image (screenshot.controller.ts) - the only
 * place apps/api reads screenshot bytes back off disk, rather than exposing
 * the storage directory publicly.
 */
export const SCREENSHOT_STORAGE_TOKEN = "SCREENSHOT_STORAGE";

export const screenshotStorageProvider: Provider = {
  provide: SCREENSHOT_STORAGE_TOKEN,
  useFactory: (): ScreenshotStorage =>
    new LocalDiskScreenshotStorage(process.env.SCREENSHOT_STORAGE_ROOT ?? "./storage/screenshots"),
};
