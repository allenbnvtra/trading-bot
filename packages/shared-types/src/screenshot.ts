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
