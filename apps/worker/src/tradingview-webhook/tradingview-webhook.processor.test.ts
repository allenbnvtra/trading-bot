import type { Job } from "bullmq";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingViewWebhookJobPayload } from "@trading-copilot/shared-types";
import { TradingViewWebhookProcessor } from "./tradingview-webhook.processor";

const {
  inboundWebhookEventsRepository,
  marketSnapshotsRepository,
  setupsRepository,
  strategiesRepository,
  tradingViewInstrumentMappingsRepository,
  publishRealtimeEvent,
} = vi.hoisted(() => ({
  inboundWebhookEventsRepository: {
    getInboundWebhookEvent: vi.fn(),
    markInboundWebhookEventProcessing: vi.fn(),
    markInboundWebhookEventRejected: vi.fn(),
    markInboundWebhookEventProcessed: vi.fn(),
    markInboundWebhookEventFailed: vi.fn(),
    emitWebhookNormalized: vi.fn(),
    emitSignalAccepted: vi.fn(),
  },
  marketSnapshotsRepository: { createMarketSnapshot: vi.fn() },
  setupsRepository: { createSetup: vi.fn(), findSetupBySourceWebhookEventId: vi.fn() },
  strategiesRepository: { findStrategyVersionByKeyAndVersion: vi.fn() },
  tradingViewInstrumentMappingsRepository: { resolveInstrumentMapping: vi.fn() },
  publishRealtimeEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@trading-copilot/database", () => ({
  inboundWebhookEventsRepository,
  marketSnapshotsRepository,
  setupsRepository,
  strategiesRepository,
  tradingViewInstrumentMappingsRepository,
}));

vi.mock("../common/realtime-publisher", () => ({ publishRealtimeEvent }));

function makeValidV1Payload(overrides: Record<string, unknown> = {}) {
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

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    provider: "TRADINGVIEW",
    receivedAt: new Date("2026-09-18T01:30:02.000Z"),
    schemaVersion: 1,
    rawPayload: makeValidV1Payload(),
    normalizedPayload: null,
    fingerprint: "fingerprint-1",
    processingStatus: "QUEUED",
    processingStartedAt: null,
    processingCompletedAt: null,
    failureCode: null,
    failureMessage: null,
    setupId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

function makeJob(inboundWebhookEventId: string): Job<TradingViewWebhookJobPayload> {
  return { data: { inboundWebhookEventId } } as Job<TradingViewWebhookJobPayload>;
}

describe("TradingViewWebhookProcessor", () => {
  let processor: TradingViewWebhookProcessor;
  let setupExpirationQueue: ReturnType<typeof makeQueue>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupExpirationQueue = makeQueue();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BullMQ Queue mock.
    processor = new TradingViewWebhookProcessor(setupExpirationQueue as any);
    // Default: no prior Setup exists for this webhook event, so the normal
    // creation path runs. Tests exercising the recovery/idempotency branch
    // override this to return an existing Setup.
    setupsRepository.findSetupBySourceWebhookEventId.mockResolvedValue(null);
  });

  it("short-circuits without reprocessing when the event is already PROCESSED (idempotent retry)", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(
      makeEvent({ processingStatus: "PROCESSED", setupId: "setup-1" }),
    );

    await processor.process(makeJob("event-1"));

    expect(inboundWebhookEventsRepository.markInboundWebhookEventProcessing).not.toHaveBeenCalled();
    expect(setupsRepository.createSetup).not.toHaveBeenCalled();
  });

  it("rejects with UNKNOWN_INSTRUMENT and creates no Setup when the instrument mapping doesn't resolve", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(makeEvent());
    tradingViewInstrumentMappingsRepository.resolveInstrumentMapping.mockResolvedValue(null);

    await processor.process(makeJob("event-1"));

    expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ failureCode: "UNKNOWN_INSTRUMENT" }),
    );
    expect(setupsRepository.createSetup).not.toHaveBeenCalled();
    expect(strategiesRepository.findStrategyVersionByKeyAndVersion).not.toHaveBeenCalled();
  });

  it("rejects with UNKNOWN_STRATEGY_VERSION and creates no Setup when the strategy version doesn't resolve", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(makeEvent());
    tradingViewInstrumentMappingsRepository.resolveInstrumentMapping.mockResolvedValue({
      id: "instrument-1",
    });
    strategiesRepository.findStrategyVersionByKeyAndVersion.mockResolvedValue(null);

    await processor.process(makeJob("event-1"));

    expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ failureCode: "UNKNOWN_STRATEGY_VERSION" }),
    );
    expect(setupsRepository.createSetup).not.toHaveBeenCalled();
  });

  it("rejects with MALFORMED_PAYLOAD when the candle invariants are violated (high < low)", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(
      makeEvent({ rawPayload: makeValidV1Payload({ high: "20000.00", low: "20120.00" }) }),
    );

    await processor.process(makeJob("event-1"));

    expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ failureCode: "MALFORMED_PAYLOAD" }),
    );
    expect(setupsRepository.createSetup).not.toHaveBeenCalled();
  });

  it("rejects with MALFORMED_PAYLOAD when the stored rawPayload no longer matches the v1 schema", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(
      makeEvent({ rawPayload: { schemaVersion: 1, source: "TRADINGVIEW" } }),
    );

    await processor.process(makeJob("event-1"));

    expect(inboundWebhookEventsRepository.markInboundWebhookEventRejected).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ failureCode: "MALFORMED_PAYLOAD" }),
    );
  });

  it("happy path: normalizes, resolves instrument/strategy, creates snapshot + Setup, schedules expiration, publishes setup.created", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(makeEvent());
    tradingViewInstrumentMappingsRepository.resolveInstrumentMapping.mockResolvedValue({
      id: "instrument-1",
    });
    strategiesRepository.findStrategyVersionByKeyAndVersion.mockResolvedValue({
      strategy: { id: "strategy-1", key: "ema-trend-pullback" },
      strategyVersion: { id: "strategy-version-1", version: "1.0.0" },
    });
    marketSnapshotsRepository.createMarketSnapshot.mockResolvedValue({ id: "snapshot-1" });
    setupsRepository.createSetup.mockResolvedValue({
      id: "setup-1",
      instrumentId: "instrument-1",
      direction: "LONG",
      status: "WATCH",
    });

    await processor.process(makeJob("event-1"));

    expect(inboundWebhookEventsRepository.markInboundWebhookEventProcessing).toHaveBeenCalledWith(
      "event-1",
    );
    expect(inboundWebhookEventsRepository.emitWebhookNormalized).toHaveBeenCalledWith("event-1");

    expect(marketSnapshotsRepository.createMarketSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ instrumentId: "instrument-1", timeframe: "5m" }),
    );

    const setupInput = setupsRepository.createSetup.mock.calls[0]![0];
    expect(setupInput.plannedEntry).toBeInstanceOf(Decimal);
    expect(setupInput.plannedEntry.toString()).toBe("20126.75");
    expect(setupInput.plannedStop).toBeNull();
    expect(setupInput.plannedTarget1).toBeNull();
    expect(setupInput.expiresAt).toBeInstanceOf(Date);
    // Default expiry is 60 minutes past the bar time (2026-09-18T01:30:00Z).
    expect(setupInput.expiresAt.toISOString()).toBe("2026-09-18T02:30:00.000Z");

    expect(inboundWebhookEventsRepository.emitSignalAccepted).toHaveBeenCalledWith("event-1", {
      setupId: "setup-1",
      instrumentId: "instrument-1",
      strategyId: "strategy-1",
      strategyVersionId: "strategy-version-1",
    });
    expect(inboundWebhookEventsRepository.markInboundWebhookEventProcessed).toHaveBeenCalledWith(
      "event-1",
      expect.objectContaining({ setupId: "setup-1" }),
    );
    expect(setupExpirationQueue.add).toHaveBeenCalledWith(
      "expire",
      { setupId: "setup-1" },
      expect.objectContaining({ delay: expect.any(Number) }),
    );
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "setup.created", setupId: "setup-1" }),
    );
  });

  it("on an unexpected thrown error: marks FAILED with INTERNAL_ERROR and rethrows for BullMQ's retry", async () => {
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(makeEvent());
    tradingViewInstrumentMappingsRepository.resolveInstrumentMapping.mockRejectedValue(
      new Error("database unreachable"),
    );

    await expect(processor.process(makeJob("event-1"))).rejects.toThrow("database unreachable");

    expect(inboundWebhookEventsRepository.markInboundWebhookEventFailed).toHaveBeenCalledWith(
      "event-1",
      { failureMessage: "database unreachable", failureCode: "INTERNAL_ERROR" },
    );
  });

  it("simulated retry-after-partial-failure: a PROCESSED event on retry never re-creates a Setup", async () => {
    // First attempt succeeds fully.
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValueOnce(makeEvent());
    tradingViewInstrumentMappingsRepository.resolveInstrumentMapping.mockResolvedValue({
      id: "instrument-1",
    });
    strategiesRepository.findStrategyVersionByKeyAndVersion.mockResolvedValue({
      strategy: { id: "strategy-1", key: "ema-trend-pullback" },
      strategyVersion: { id: "strategy-version-1", version: "1.0.0" },
    });
    marketSnapshotsRepository.createMarketSnapshot.mockResolvedValue({ id: "snapshot-1" });
    setupsRepository.createSetup.mockResolvedValue({
      id: "setup-1",
      instrumentId: "instrument-1",
      direction: "LONG",
      status: "WATCH",
    });

    await processor.process(makeJob("event-1"));
    expect(setupsRepository.createSetup).toHaveBeenCalledTimes(1);

    // BullMQ retries the same job; a fresh read now reports PROCESSED.
    inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValueOnce(
      makeEvent({ processingStatus: "PROCESSED", setupId: "setup-1" }),
    );

    await processor.process(makeJob("event-1"));

    expect(setupsRepository.createSetup).toHaveBeenCalledTimes(1);
  });

  it(
    "regression: a retry landing while the event is still PROCESSING/FAILED (not yet PROCESSED) " +
      "finds and reuses an already-created Setup instead of creating a second one",
    async () => {
      // The event is stuck at PROCESSING/FAILED - neither is in
      // ALREADY_RESOLVED_STATUSES, so the early short-circuit does not
      // apply and process() runs the full pipeline again.
      inboundWebhookEventsRepository.getInboundWebhookEvent.mockResolvedValue(
        makeEvent({ processingStatus: "FAILED" }),
      );
      tradingViewInstrumentMappingsRepository.resolveInstrumentMapping.mockResolvedValue({
        id: "instrument-1",
      });
      strategiesRepository.findStrategyVersionByKeyAndVersion.mockResolvedValue({
        strategy: { id: "strategy-1", key: "ema-trend-pullback" },
        strategyVersion: { id: "strategy-version-1", version: "1.0.0" },
      });
      // A prior attempt already created a Setup for this webhook event
      // before crashing/throwing.
      setupsRepository.findSetupBySourceWebhookEventId.mockResolvedValue({
        id: "setup-existing",
        instrumentId: "instrument-1",
        direction: "LONG",
        status: "WATCH",
        expiresAt: new Date("2026-09-18T02:30:00.000Z"),
      });

      await processor.process(makeJob("event-1"));

      expect(marketSnapshotsRepository.createMarketSnapshot).not.toHaveBeenCalled();
      expect(setupsRepository.createSetup).not.toHaveBeenCalled();
      expect(inboundWebhookEventsRepository.emitSignalAccepted).not.toHaveBeenCalled();

      // Still recovers: the expiration job is (re-)scheduled and the event
      // is marked PROCESSED against the *existing* Setup.
      expect(setupExpirationQueue.add).toHaveBeenCalledWith(
        "expire",
        { setupId: "setup-existing" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      expect(inboundWebhookEventsRepository.markInboundWebhookEventProcessed).toHaveBeenCalledWith(
        "event-1",
        expect.objectContaining({ setupId: "setup-existing" }),
      );

      // No duplicate "setup.created" announcement for a Setup the dashboard
      // may already know about from before the crash.
      expect(publishRealtimeEvent).not.toHaveBeenCalled();
    },
  );
});
