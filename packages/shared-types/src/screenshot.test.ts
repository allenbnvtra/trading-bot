import { describe, expect, it } from "vitest";
import {
  CHART_CONFIG_VERSION,
  PRE_TRADE_CANDLE_COUNT_DEFAULT,
  SCREENSHOT_RENDER_HEIGHT,
  SCREENSHOT_RENDER_WIDTH,
} from "./screenshot";

describe("screenshot constants", () => {
  it("defines a deterministic render size and candle window", () => {
    expect(SCREENSHOT_RENDER_WIDTH).toBe(1440);
    expect(SCREENSHOT_RENDER_HEIGHT).toBe(900);
    expect(PRE_TRADE_CANDLE_COUNT_DEFAULT).toBe(150);
    expect(CHART_CONFIG_VERSION).toBe("1.0.0");
  });
});
