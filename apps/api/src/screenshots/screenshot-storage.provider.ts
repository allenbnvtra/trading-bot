import type { Provider } from "@nestjs/common";
import {
  LocalDiskScreenshotStorage,
  resolveScreenshotStorageRoot,
  type ScreenshotStorage,
} from "@trading-copilot/screenshot-storage";

/**
 * Mirrors apps/worker/src/screenshot-generation/screenshot-storage.provider.ts
 * exactly (same token value, same factory, same env var, same root
 * resolution). apps/api and apps/worker are separate NestJS processes with
 * separate DI containers, so this provider can't be shared as a single
 * instance across them - this is apps/api's own registration, reading the
 * same SCREENSHOT_STORAGE_ROOT env var.
 *
 * A relative SCREENSHOT_STORAGE_ROOT (the .env.example default,
 * "./storage/screenshots") is NOT resolved against this process's own
 * process.cwd(). Each process is normally started via
 * `pnpm --filter <pkg> start`, which sets process.cwd() to that package's
 * OWN directory (apps/api/ here, apps/worker/ for the worker) - resolving a
 * relative root against process.cwd() would therefore give apps/api and
 * apps/worker two different, disjoint on-disk directories for the same env
 * var, and a screenshot the worker wrote would never be found here.
 * resolveScreenshotStorageRoot instead anchors a relative root to the
 * monorepo root (found by walking up from its own module location to
 * pnpm-workspace.yaml), which is the same fixed point regardless of which
 * process calls it, so both processes agree on one on-disk root. An
 * absolute SCREENSHOT_STORAGE_ROOT is passed through unchanged.
 *
 * This is what backs GET /screenshots/:id/image (screenshot.controller.ts)
 * - the only place apps/api reads screenshot bytes back off disk, rather
 * than exposing the storage directory publicly.
 */
export const SCREENSHOT_STORAGE_TOKEN = "SCREENSHOT_STORAGE";

export const screenshotStorageProvider: Provider = {
  provide: SCREENSHOT_STORAGE_TOKEN,
  useFactory: (): ScreenshotStorage =>
    new LocalDiskScreenshotStorage(
      resolveScreenshotStorageRoot(process.env.SCREENSHOT_STORAGE_ROOT ?? "./storage/screenshots"),
    ),
};
