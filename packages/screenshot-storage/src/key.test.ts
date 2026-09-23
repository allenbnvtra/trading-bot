import { describe, expect, it } from "vitest";
import { buildScreenshotStorageKey } from "./key";

const SETUP_ID = "11111111-1111-1111-1111-111111111111";
const TRADE_ID = "22222222-2222-2222-2222-222222222222";

describe("buildScreenshotStorageKey", () => {
  it("builds a PRE_TRADE key under setups/<id>/pre-trade/<version>.png", () => {
    expect(
      buildScreenshotStorageKey({
        setupId: SETUP_ID,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toBe(`setups/${SETUP_ID}/pre-trade/1.0.0.png`);
  });

  it("builds a POST_TRADE key under trades/<source>/<id>/post-trade/<version>.png", () => {
    expect(
      buildScreenshotStorageKey({
        setupId: null,
        tradeId: TRADE_ID,
        tradeSource: "JOURNAL_TRADE",
        type: "POST_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toBe(`trades/journal-trade/${TRADE_ID}/post-trade/1.0.0.png`);
  });

  it("rejects an id that is not a well-formed UUID, preventing path traversal from a malformed id", () => {
    expect(() =>
      buildScreenshotStorageKey({
        setupId: "../../etc/passwd",
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toThrow(/not a valid id/i);
  });

  it("rejects a chartConfigVersion containing path separators", () => {
    expect(() =>
      buildScreenshotStorageKey({
        setupId: SETUP_ID,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "../1.0.0",
      }),
    ).toThrow(/invalid chartConfigVersion/i);
  });

  it("requires either setupId or tradeId+tradeSource, never neither", () => {
    expect(() =>
      buildScreenshotStorageKey({
        setupId: null,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toThrow(/either setupId or tradeId/i);
  });
});
