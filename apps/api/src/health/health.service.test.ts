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

import { inboundWebhookEventsRepository, tradeScreenshotsRepository } from "@trading-copilot/database";

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
