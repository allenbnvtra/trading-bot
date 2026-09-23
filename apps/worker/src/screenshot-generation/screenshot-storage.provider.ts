import type { Provider } from "@nestjs/common";
import { LocalDiskScreenshotStorage, type ScreenshotStorage } from "@trading-copilot/screenshot-storage";

/**
 * No existing precedent in this codebase for a non-class NestJS injection
 * token (checked: every other provider/constructor param is a concrete
 * class), so this follows the standard NestJS pattern for an interface-typed
 * provider (ScreenshotStorage has no runtime value to use as a token) -
 * a plain string token, paired with @Inject(SCREENSHOT_STORAGE_TOKEN) at the
 * one call site (screenshot-generation.processor.ts). Kept as a shared
 * constant rather than an inline literal so the provider registration
 * (app.module.ts) and the @Inject() call site can never drift out of sync.
 */
export const SCREENSHOT_STORAGE_TOKEN = "SCREENSHOT_STORAGE";

export const screenshotStorageProvider: Provider = {
  provide: SCREENSHOT_STORAGE_TOKEN,
  useFactory: (): ScreenshotStorage =>
    new LocalDiskScreenshotStorage(process.env.SCREENSHOT_STORAGE_ROOT ?? "./storage/screenshots"),
};
