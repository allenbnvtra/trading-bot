import { describe, expect, it } from "vitest";
import {
  CHART_CONFIG_VERSION,
  createPostTradeScreenshotSchema,
  createPreTradeScreenshotSchema,
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

describe("screenshot request body schemas", () => {
  for (const [name, schema] of [
    ["pre-trade", createPreTradeScreenshotSchema],
    ["post-trade", createPostTradeScreenshotSchema],
  ] as const) {
    describe(`${name} screenshot schema`, () => {
      it("accepts undefined (a bodyless request - no Content-Type header)", () => {
        expect(schema.safeParse(undefined).success).toBe(true);
      });

      it("accepts an empty object body", () => {
        expect(schema.safeParse({}).success).toBe(true);
      });

      it("rejects a body with an unexpected key", () => {
        expect(schema.safeParse({ a: 1 }).success).toBe(false);
      });

      it("rejects a non-object body", () => {
        expect(schema.safeParse([]).success).toBe(false);
      });
    });
  }
});
