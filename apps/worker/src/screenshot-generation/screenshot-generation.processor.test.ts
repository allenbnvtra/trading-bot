import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenshotGenerationProcessor } from "./screenshot-generation.processor";

vi.mock("@trading-copilot/database", () => ({
  tradeScreenshotsRepository: {
    getScreenshot: vi.fn(),
    markScreenshotGenerating: vi.fn(),
    markScreenshotReady: vi.fn(),
    markScreenshotFailed: vi.fn(),
  },
}));

import { tradeScreenshotsRepository } from "@trading-copilot/database";

function buildPage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    setViewportSize: vi.fn(),
    goto: vi.fn(),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ state: "ready" }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
    close: vi.fn(),
    ...overrides,
  };
}

function buildContext() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

function buildProcessor(
  page: ReturnType<typeof buildPage>,
  storage = { save: vi.fn(), read: vi.fn(), exists: vi.fn(), delete: vi.fn() },
) {
  const context = buildContext();
  const browserManager = { getPage: vi.fn().mockResolvedValue({ page, context }) };
  const processor = new ScreenshotGenerationProcessor(browserManager as never, storage as never);
  return { processor, storage, context, browserManager };
}

describe("ScreenshotGenerationProcessor", () => {
  beforeEach(() => {
    // The worker's vitest config doesn't clear mocks globally, and
    // tradeScreenshotsRepository's mocked functions are shared module-level
    // vi.fn()s across every test in this file - without this, call history
    // (and any toHaveBeenCalledWith assertion) can silently carry over
    // between tests and mask a real bug.
    vi.clearAllMocks();
  });

  it("is a no-op when the screenshot row is already READY (idempotent retry)", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({ status: "READY" } as never);
    const page = buildPage();
    const { processor, browserManager } = buildProcessor(page);

    await processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never);

    expect(browserManager.getPage).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    expect(tradeScreenshotsRepository.markScreenshotGenerating).not.toHaveBeenCalled();
  });

  it("marks READY with storage metadata on a successful render, and closes the BrowserContext (not just the Page)", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "11111111-1111-1111-1111-111111111111", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({ evaluate: vi.fn().mockResolvedValue({ state: "ready" }) });
    const { processor, storage, context } = buildProcessor(page);

    await processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never);

    expect(storage.save).toHaveBeenCalledWith(expect.stringContaining("setups/11111111-1111-1111-1111-111111111111/pre-trade/1.0.0.png"), expect.any(Buffer), "image/png");
    expect(tradeScreenshotsRepository.markScreenshotReady).toHaveBeenCalled();
    // Regression test for the context-leak finding: closing only the Page
    // does not close its BrowserContext on the real Playwright API, so the
    // processor must close the context explicitly.
    expect(context.close).toHaveBeenCalled();
  });

  it("marks FAILED with the renderer's own error code/message when the page signals an error", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "11111111-1111-1111-1111-111111111111", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({
      evaluate: vi.fn().mockResolvedValue({ state: "error", code: "NO_CANDLES", message: "No candles available" }),
    });
    const { processor } = buildProcessor(page);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "NO_CANDLES" }),
    );
  });

  it("marks FAILED with RENDER_TIMEOUT when waitForFunction times out", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "11111111-1111-1111-1111-111111111111", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({ waitForFunction: vi.fn().mockRejectedValue(new Error("Timeout 15000ms exceeded")) });
    const { processor } = buildProcessor(page);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "RENDER_TIMEOUT", failureMessage: expect.stringContaining("Timeout 15000ms exceeded") }),
    );
  });

  it("marks FAILED with NAVIGATION_FAILED (preserving the real error) when page.goto itself fails", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "11111111-1111-1111-1111-111111111111", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({ goto: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3000")) });
    const { processor } = buildProcessor(page);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(page.waitForFunction).not.toHaveBeenCalled();
    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({
        failureCode: "NAVIGATION_FAILED",
        failureMessage: expect.stringContaining("ECONNREFUSED"),
      }),
    );
  });

  it("marks FAILED with STORAGE_WRITE_FAILED when storage.save throws", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "11111111-1111-1111-1111-111111111111", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage();
    const storage = { save: vi.fn().mockRejectedValue(new Error("disk full")), read: vi.fn(), exists: vi.fn(), delete: vi.fn() };
    const { processor } = buildProcessor(page, storage);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "STORAGE_WRITE_FAILED" }),
    );
  });

  it("marks FAILED with JOB_TYPE_MISMATCH when job.name disagrees with screenshot.type, without starting any browser work", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: null, tradeId: "22222222-2222-2222-2222-222222222222", tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage();
    const { processor, browserManager } = buildProcessor(page);

    // Wrong job name for a POST_TRADE screenshot row.
    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(browserManager.getPage).not.toHaveBeenCalled();
    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "JOB_TYPE_MISMATCH" }),
    );
  });
});
