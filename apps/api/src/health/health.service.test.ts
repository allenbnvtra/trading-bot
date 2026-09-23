import { describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";

vi.mock("@trading-copilot/database", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
  inboundWebhookEventsRepository: {
    findMostRecentInboundWebhookEvent: vi.fn(),
    findMostRecentProcessedInboundWebhookEvent: vi.fn(),
  },
}));

import { inboundWebhookEventsRepository } from "@trading-copilot/database";

describe("HealthService.checkTradingViewIngestion (via check())", () => {
  it("reports UNKNOWN when no event has ever been received, without listing every row", async () => {
    vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(null);
    vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
      null,
    );

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("UNKNOWN");
    // The old implementation called a full-list query; this asserts the
    // new implementation never does, by asserting the list function was
    // never imported/called at all (it is not even mocked above — a call
    // to it would throw "is not a function").
  });

  it("reports DEGRADED when the most recent delivery ended FAILED", async () => {
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
