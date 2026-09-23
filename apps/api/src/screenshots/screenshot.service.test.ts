import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenshotService } from "./screenshot.service";

vi.mock("@trading-copilot/database", () => ({
  setupsRepository: { getSetup: vi.fn() },
  journalTradesRepository: { getJournalTrade: vi.fn() },
  tradeScreenshotsRepository: { requestOrRetryScreenshot: vi.fn() },
}));

import { journalTradesRepository, setupsRepository, tradeScreenshotsRepository } from "@trading-copilot/database";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScreenshotService.requestPreTradeScreenshot", () => {
  it("looks up the Setup for its marketSnapshotId, then requests idempotently, then enqueues only when not already in flight", async () => {
    vi.mocked(setupsRepository.getSetup).mockResolvedValue({ id: "setup-1", marketSnapshotId: "snap-1" } as never);
    vi.mocked(tradeScreenshotsRepository.requestOrRetryScreenshot).mockResolvedValue({
      screenshot: { id: "screenshot-1" } as never,
      alreadyInFlight: false,
    });

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);
    const result = await service.requestPreTradeScreenshot("setup-1");

    expect(tradeScreenshotsRepository.requestOrRetryScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ setupId: "setup-1", type: "PRE_TRADE", marketSnapshotId: "snap-1" }),
    );
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), { screenshotId: "screenshot-1" });
    expect(result.id).toBe("screenshot-1");
  });

  it("does not re-enqueue when the screenshot is already in flight", async () => {
    vi.mocked(setupsRepository.getSetup).mockResolvedValue({ id: "setup-1", marketSnapshotId: "snap-1" } as never);
    vi.mocked(tradeScreenshotsRepository.requestOrRetryScreenshot).mockResolvedValue({
      screenshot: { id: "screenshot-1" } as never,
      alreadyInFlight: true,
    });

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);
    await service.requestPreTradeScreenshot("setup-1");

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("404s when the Setup does not exist", async () => {
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(null);

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);

    await expect(service.requestPreTradeScreenshot("missing")).rejects.toMatchObject({ status: 404 });
    expect(tradeScreenshotsRepository.requestOrRetryScreenshot).not.toHaveBeenCalled();
  });
});

describe("ScreenshotService.requestPostTradeScreenshot", () => {
  it("looks up the JournalTrade, requests idempotently with setupId: null (a POST_TRADE row is keyed on tradeId, not setupId), then enqueues", async () => {
    vi.mocked(journalTradesRepository.getJournalTrade).mockResolvedValue({
      id: "trade-1",
      setupId: "setup-1",
      status: "CLOSED",
    } as never);
    vi.mocked(tradeScreenshotsRepository.requestOrRetryScreenshot).mockResolvedValue({
      screenshot: { id: "screenshot-2" } as never,
      alreadyInFlight: false,
    });

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);
    const result = await service.requestPostTradeScreenshot("trade-1");

    expect(tradeScreenshotsRepository.requestOrRetryScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        setupId: null,
        tradeId: "trade-1",
        tradeSource: "JOURNAL_TRADE",
        type: "POST_TRADE",
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), { screenshotId: "screenshot-2" });
    expect(result.id).toBe("screenshot-2");
  });

  it("does not re-enqueue when the screenshot is already in flight", async () => {
    vi.mocked(journalTradesRepository.getJournalTrade).mockResolvedValue({
      id: "trade-1",
      setupId: null,
      status: "CLOSED",
    } as never);
    vi.mocked(tradeScreenshotsRepository.requestOrRetryScreenshot).mockResolvedValue({
      screenshot: { id: "screenshot-2" } as never,
      alreadyInFlight: true,
    });

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);
    await service.requestPostTradeScreenshot("trade-1");

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("404s when the JournalTrade does not exist", async () => {
    vi.mocked(journalTradesRepository.getJournalTrade).mockResolvedValue(null);

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);

    await expect(service.requestPostTradeScreenshot("missing")).rejects.toMatchObject({ status: 404 });
    expect(tradeScreenshotsRepository.requestOrRetryScreenshot).not.toHaveBeenCalled();
  });

  it("404s when the JournalTrade is not CLOSED yet", async () => {
    vi.mocked(journalTradesRepository.getJournalTrade).mockResolvedValue({
      id: "trade-1",
      setupId: null,
      status: "OPEN",
    } as never);

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);

    await expect(service.requestPostTradeScreenshot("trade-1")).rejects.toMatchObject({ status: 404 });
    expect(tradeScreenshotsRepository.requestOrRetryScreenshot).not.toHaveBeenCalled();
  });
});
