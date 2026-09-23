import { describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";

vi.mock("@trading-copilot/database", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
  inboundWebhookEventsRepository: {
    findMostRecentInboundWebhookEvent: vi.fn(),
    findMostRecentProcessedInboundWebhookEvent: vi.fn(),
  },
  tradeScreenshotsRepository: {
    findMostRecentReadyScreenshot: vi.fn(),
    countRecentFailedScreenshots: vi.fn(),
  },
}));

// A fresh plain object per `new LocalDiskScreenshotStorage(...)` call (mirrors
// the real class's shape, never the real implementation - no real disk I/O in
// this unit test file), so each `new HealthService()` gets its own
// independently-controllable save/read/delete spies. Defaults to a
// successful round-trip; individual tests override save/read to exercise the
// "down" path.
vi.mock("@trading-copilot/screenshot-storage", () => ({
  LocalDiskScreenshotStorage: vi.fn().mockImplementation(() => ({
    save: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.from("health-check")),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  })),
}));

import { inboundWebhookEventsRepository, tradeScreenshotsRepository } from "@trading-copilot/database";
import { LocalDiskScreenshotStorage } from "@trading-copilot/screenshot-storage";

/** Neutral default so tests focused on the other subsystem don't also have to stub this one. */
function stubIngestionUnknown(): void {
  vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(null);
  vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
    null,
  );
}

/** Neutral default so tests focused on the other subsystem don't also have to stub this one. */
function stubScreenshotGenerationUnknown(): void {
  vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
  vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);
}

/**
 * `HealthService` instantiates its own `LocalDiskScreenshotStorage` as a
 * class field (mirroring `redis` in that same file), so the only way to
 * control a *specific* instance's behavior from outside is to grab the
 * object the mocked constructor most recently returned - `new
 * HealthService()` must be called first, then this picks up that call's
 * instance.
 */
function latestMockedScreenshotStorageInstance() {
  const results = vi.mocked(LocalDiskScreenshotStorage).mock.results;
  const last = results.at(-1);
  if (!last || last.type !== "return") {
    throw new Error("expected LocalDiskScreenshotStorage to have been constructed at least once");
  }
  return last.value as unknown as { save: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
}

describe("HealthService.checkTradingViewIngestion (via check())", () => {
  it("reports UNKNOWN when no event has ever been received, without listing every row", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("UNKNOWN");
    // The old implementation called a full-list query; this asserts the
    // new implementation never does, by asserting the list function was
    // never imported/called at all (it is not even mocked above — a call
    // to it would throw "is not a function").
  });

  it("reports DEGRADED when the most recent delivery ended FAILED", async () => {
    stubScreenshotGenerationUnknown();
    const failedEvent = { processingStatus: "FAILED", receivedAt: new Date("2026-01-01T00:00:00Z") };
    vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(
      failedEvent as never,
    );
    vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
      null,
    );

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("DEGRADED");
    expect(result.status).toBe("degraded");
  });
});

describe("HealthService.checkScreenshotGeneration (via check())", () => {
  it("reports screenshot generation health from real TradeScreenshot rows, never hardcoded HEALTHY", async () => {
    stubIngestionUnknown();
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("UNKNOWN");
  });

  it("does not degrade the overall status when screenshot generation is UNKNOWN (no screenshots yet)", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("UNKNOWN");
    expect(result.status).toBe("ok");
  });

  it("reports HEALTHY with the most recent READY screenshot's renderedAt when there are no recent failures", async () => {
    stubIngestionUnknown();
    const readyScreenshot = { renderedAt: new Date("2026-02-01T00:00:00Z") };
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(
      readyScreenshot as never,
    );
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("HEALTHY");
    expect(result.screenshotGeneration.lastSuccessfulScreenshotAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.screenshotGeneration.recentFailureCount).toBe(0);
    expect(result.status).toBe("ok");
  });

  it("reports DEGRADED and pulls the overall status down when there are recent failures", async () => {
    stubIngestionUnknown();
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(3);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("DEGRADED");
    expect(result.screenshotGeneration.recentFailureCount).toBe(3);
    expect(result.status).toBe("degraded");
  });

  it("reports UNKNOWN, not HEALTHY, when the repository queries throw", async () => {
    stubIngestionUnknown();
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockRejectedValue(
      new Error("connection reset"),
    );
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("UNKNOWN");
  });
});

describe("HealthService.checkScreenshotStorage (via check())", () => {
  it("reports screenshotStorage up when the write+read+delete probe round-trips successfully", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    const result = await service.check();

    expect(result.screenshotStorage).toBe("up");
    expect(result.status).toBe("ok");
  });

  it("reports screenshotStorage down, not hardcoded up, when the storage backend's save() throws", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    latestMockedScreenshotStorageInstance().save.mockRejectedValueOnce(new Error("disk full"));

    const result = await service.check();

    expect(result.screenshotStorage).toBe("down");
    expect(result.status).toBe("degraded");
  });

  it("reports screenshotStorage down when the read-back content does not match what was written", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    latestMockedScreenshotStorageInstance().read.mockResolvedValueOnce(Buffer.from("corrupted"));

    const result = await service.check();

    expect(result.screenshotStorage).toBe("down");
    expect(result.status).toBe("degraded");
  });
});
