import { z } from "zod";

/**
 * chartConfigVersion for the current rendering configuration (layout,
 * dimensions, visible candle count, annotation behavior). Bump this and
 * only this — never mutate an existing TradeScreenshot row — whenever
 * rendering behavior changes (docs/screenshot-design.md).
 */
export const CHART_CONFIG_VERSION = "1.0.0";

/** Default number of candles ending at/before the cutoff, for a PRE_TRADE render. */
export const PRE_TRADE_CANDLE_COUNT_DEFAULT = 150;

/** Deterministic screenshot dimensions — never a random/ambient browser viewport. */
export const SCREENSHOT_RENDER_WIDTH = 1440;
export const SCREENSHOT_RENDER_HEIGHT = 900;

/** How long Playwright waits for the render-ready DOM signal before treating it as a timeout failure. */
export const RENDER_READY_TIMEOUT_MS = 15_000;

export const SCREENSHOT_QUEUE = "screenshot-generation";
export const GENERATE_PRE_TRADE_SCREENSHOT_JOB = "generate-pre-trade-screenshot";
export const GENERATE_POST_TRADE_SCREENSHOT_JOB = "generate-post-trade-screenshot";

export interface ScreenshotGenerationJobPayload {
  screenshotId: string;
}

/**
 * Both PRE_TRADE/POST_TRADE screenshot-generation endpoints take no
 * meaningful request body — the setup/trade id comes from the URL path
 * param. `.strict().optional()` (not a bare `z.object({})`) is deliberate:
 * a bodyless `curl -X POST` (no Content-Type header) leaves Nest's
 * `@Body()` as `undefined`, and a bare `z.object({})` fails
 * `.safeParse(undefined)` — that would 400 the exact "no body" case these
 * routes' manual/admin re-trigger use case relies on. `.optional()` accepts
 * `undefined` and `{}` while `.strict()` still rejects an unexpected key
 * (verified: `undefined` passes, `{}` passes, `{a:1}` fails, `[]` fails) —
 * see screenshot.test.ts. Both routes actually wire this in via
 * `@Body(new ZodValidationPipe(...))` (apps/api's
 * setup.controller.ts/journal-trade.controller.ts), matching every other
 * endpoint's convention.
 */
export const createPreTradeScreenshotSchema = z.object({}).strict().optional();
export type CreatePreTradeScreenshotInput = z.infer<typeof createPreTradeScreenshotSchema>;

export const createPostTradeScreenshotSchema = z.object({}).strict().optional();
export type CreatePostTradeScreenshotInput = z.infer<typeof createPostTradeScreenshotSchema>;
