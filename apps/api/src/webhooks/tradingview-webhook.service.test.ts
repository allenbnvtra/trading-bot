import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TradingViewWebhookService } from "./tradingview-webhook.service";

const { inboundWebhookEventsRepository } = vi.hoisted(() => ({
  inboundWebhookEventsRepository: {
    createInboundWebhookEvent: vi.fn(),
    markInboundWebhookEventQueued: vi.fn(),
    markInboundWebhookEventUnsupported: vi.fn(),
    markInboundWebhookEventRejected: vi.fn(),
    listInboundWebhookEvents: vi.fn(),
    getInboundWebhookEvent: vi.fn(),
    getFullTradingViewTimeline: vi.fn(),
  },
}));

vi.mock("@trading-copilot/database", () => ({ inboundWebhookEventsRepository }));

// A plain ioredis client is only ever used to PUBLISH; mock it away so
// these unit tests never attempt a real network connection.
vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockResolvedValue(1),
    disconnect: vi.fn(),
  })),
}));

function makeQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeValidV1Body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    source: "TRADINGVIEW",
    strategyKey: "ema-trend-pullback",
    strategyVersion: "1.0.0",
    exchange: "CME",
    symbol: "NQ1!",
    timeframe: "5",
    signal: "SETUP_CANDIDATE",
    direction: "LONG",
    barTime: "2026-09-18T01:30:00.000Z",
    firedAt: "2026-09-18T01:30:01.000Z",
    open: "20123.25",
    high: "20128.50",
    low: "20120.00",
    close: "20126.75",
    volume: "1043",
    metadata: {},
    ...overrides,
  };
}

describe("TradingViewWebhookService", () => {
  let queue: ReturnType<typeof makeQueue>;
  let service: TradingViewWebhookService;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = makeQueue();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BullMQ Queue mock, casting is the simplest way to satisfy the constructor's type here.
    service = new TradingViewWebhookService(queue as any);
  });

  describe("envelope validation", () => {
    beforeEach(() => {
      inboundWebhookEventsRepository.createInboundWebhookEvent.mockResolvedValue({
        event: { id: "event-malformed", processingStatus: "RECEIVED" },
        wasDuplicate: false,
      });
      inboundWebhookEventsRepository.markInboundWebhookEventRejected.mockResolvedValue({
        id: "event-malformed",
        processingStatus: "REJECTED",
      });
    });

    it("rejects with 400 but still durably persists a REJECTED/MALFORMED_PAYLOAD row when schemaVersion is missing", async () => {
      await expect(service.ingestWebhook({ source: "TRADINGVIEW" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(inboundWebhookEventsRepository.createInboundWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "TRADINGVIEW", schemaVersion: 0 }),
      );
      expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
        "event-malformed",
        expect.objectContaining({ failureCode: "MALFORMED_PAYLOAD" }),
      );
    });

    it("rejects with 400 but still durably persists a REJECTED/MALFORMED_PAYLOAD row when source is not TRADINGVIEW", async () => {
      await expect(
        service.ingestWebhook({ schemaVersion: 1, source: "SOMETHING_ELSE" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inboundWebhookEventsRepository.createInboundWebhookEvent).toHaveBeenCalled();
      expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
        "event-malformed",
        expect.objectContaining({ failureCode: "MALFORMED_PAYLOAD" }),
      );
    });

    it("rejects with 400 but still durably persists a REJECTED/MALFORMED_PAYLOAD row for a non-object body", async () => {
      await expect(service.ingestWebhook("not-an-object")).rejects.toBeInstanceOf(BadRequestException);
      expect(inboundWebhookEventsRepository.createInboundWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ rawPayload: {} }),
      );
      expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalled();
    });

    it("never persists a duplicate row or re-marks it for a repeated identical malformed delivery", async () => {
      inboundWebhookEventsRepository.createInboundWebhookEvent.mockResolvedValue({
        event: { id: "event-malformed", processingStatus: "REJECTED" },
        wasDuplicate: true,
      });

      await expect(service.ingestWebhook({ source: "TRADINGVIEW" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).not.toHaveBeenCalled();
    });
  });

  describe("unsupported schemaVersion", () => {
    it("persists the event, marks it UNSUPPORTED, responds 202-shaped, and never enqueues a job", async () => {
      inboundWebhookEventsRepository.createInboundWebhookEvent.mockResolvedValue({
        event: { id: "event-1", processingStatus: "RECEIVED" },
        wasDuplicate: false,
      });
      inboundWebhookEventsRepository.markInboundWebhookEventUnsupported.mockResolvedValue({
        id: "event-1",
        processingStatus: "UNSUPPORTED",
      });

      const result = await service.ingestWebhook({
        schemaVersion: 2,
        source: "TRADINGVIEW",
        note: "future shape",
      });

      expect(result).toEqual({ id: "event-1", processingStatus: "UNSUPPORTED" });
      expect(inboundWebhookEventsRepository.createInboundWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "TRADINGVIEW", schemaVersion: 2 }),
      );
      expect(inboundWebhookEventsRepository.markInboundWebhookEventUnsupported).toHaveBeenCalledWith(
        "event-1",
        expect.objectContaining({ failureMessage: expect.any(String) }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("schemaVersion 1 validation", () => {
    it("rejects with 400 but still durably persists a REJECTED/MALFORMED_PAYLOAD row for an invalid v1 payload", async () => {
      inboundWebhookEventsRepository.createInboundWebhookEvent.mockResolvedValue({
        event: { id: "event-v1-malformed", processingStatus: "RECEIVED" },
        wasDuplicate: false,
      });
      inboundWebhookEventsRepository.markInboundWebhookEventRejected.mockResolvedValue({
        id: "event-v1-malformed",
        processingStatus: "REJECTED",
      });

      const malformed = makeValidV1Body({
        direction: "SIDEWAYS",
        barTime: "not-a-valid-timestamp",
        high: "1e5",
        close: "not-a-number",
        volume: "-50",
      });

      await expect(service.ingestWebhook(malformed)).rejects.toBeInstanceOf(BadRequestException);
      expect(inboundWebhookEventsRepository.createInboundWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "TRADINGVIEW", schemaVersion: 1 }),
      );
      expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
        "event-v1-malformed",
        expect.objectContaining({ failureCode: "MALFORMED_PAYLOAD" }),
      );
    });
  });

  describe("valid schemaVersion 1 payload", () => {
    it("persists the event, marks it QUEUED, and enqueues exactly one job", async () => {
      inboundWebhookEventsRepository.createInboundWebhookEvent.mockResolvedValue({
        event: { id: "event-2", processingStatus: "RECEIVED", provider: "TRADINGVIEW" },
        wasDuplicate: false,
      });
      inboundWebhookEventsRepository.markInboundWebhookEventQueued.mockResolvedValue({
        id: "event-2",
        processingStatus: "QUEUED",
      });

      const result = await service.ingestWebhook(makeValidV1Body());

      expect(result).toEqual({ id: "event-2", processingStatus: "QUEUED" });
      expect(inboundWebhookEventsRepository.markInboundWebhookEventQueued).toHaveBeenCalledWith(
        "event-2",
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith("process", { inboundWebhookEventId: "event-2" });
    });

    it("responds with wasDuplicate: true and never enqueues a second job for a duplicate delivery", async () => {
      inboundWebhookEventsRepository.createInboundWebhookEvent.mockResolvedValue({
        event: { id: "event-2", processingStatus: "PROCESSED", provider: "TRADINGVIEW" },
        wasDuplicate: true,
      });

      const result = await service.ingestWebhook(makeValidV1Body());

      expect(result).toEqual({ id: "event-2", processingStatus: "PROCESSED", wasDuplicate: true });
      expect(inboundWebhookEventsRepository.markInboundWebhookEventQueued).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
