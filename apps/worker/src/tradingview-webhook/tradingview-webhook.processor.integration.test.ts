import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inboundWebhookEventsRepository, prisma, setupsRepository } from "@trading-copilot/database";
import {
  computeTradingViewFingerprint,
  type TradingViewWebhookV1Payload,
} from "@trading-copilot/shared-types";
import { TradingViewWebhookProcessor } from "./tradingview-webhook.processor";

const { publishRealtimeEvent } = vi.hoisted(() => ({
  publishRealtimeEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../common/realtime-publisher", () => ({ publishRealtimeEvent }));

function makeQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Real end-to-end exercise of the worker's processing pipeline against a
 * live Postgres database: a genuine InboundWebhookEvent row (created via
 * the same repository apps/api's controller calls) is fed to the real
 * TradingViewWebhookProcessor, which resolves the seeded instrument/
 * strategy and creates a real Setup. See tradingview-webhook.e2e.test.ts
 * in apps/api for the HTTP-side half of this pipeline (parse -> validate
 * -> persist -> enqueue) - together the two exercise the full documented
 * pipeline without apps/api and apps/worker depending on each other's code
 * (see docs/architecture.md - they are separate deployables).
 *
 * Only the realtime publisher and the BullMQ expiration queue are
 * mocked - Redis pub/sub and a delayed job schedule are not something this
 * test needs to assert on the wire; everything that touches Postgres is
 * the real repository code.
 */
describe.skipIf(!process.env.DATABASE_URL)("TradingViewWebhookProcessor (live Postgres)", () => {
  let setupExpirationQueue: ReturnType<typeof makeQueue>;
  let processor: TradingViewWebhookProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    setupExpirationQueue = makeQueue();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BullMQ Queue mock.
    processor = new TradingViewWebhookProcessor(setupExpirationQueue as any);
  });

  function makeValidV1Payload(
    overrides: Partial<TradingViewWebhookV1Payload> = {},
  ): TradingViewWebhookV1Payload {
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
      barTime: `2027-0${1 + Math.floor(Math.random() * 8)}-15T01:30:00.000Z`,
      firedAt: new Date().toISOString(),
      open: "20123.25",
      high: "20128.50",
      low: "20120.00",
      close: "20126.75",
      volume: "1043",
      metadata: {},
      ...overrides,
    };
  }

  it(
    "full pipeline: normalize -> resolve instrument/strategy -> MarketSnapshot -> Setup -> " +
      "journal events -> PROCESSED; reprocessing the same (now PROCESSED) event creates no second Setup",
    async () => {
      const payload = makeValidV1Payload();
      const fingerprint = computeTradingViewFingerprint(payload);

      const { event, wasDuplicate } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: payload,
        fingerprint,
      });
      expect(wasDuplicate).toBe(false);
      await inboundWebhookEventsRepository.markInboundWebhookEventQueued(event.id);

      await processor.process({ data: { inboundWebhookEventId: event.id } } as never);

      const processed = await inboundWebhookEventsRepository.getInboundWebhookEvent(event.id);
      expect(processed?.processingStatus).toBe("PROCESSED");
      expect(processed?.setupId).not.toBeNull();

      const setup = await setupsRepository.getSetup(processed!.setupId!);
      expect(setup).not.toBeNull();
      expect(setup?.source).toBe("TRADINGVIEW");
      expect(setup?.status).toBe("WATCH");
      expect(setup?.direction).toBe("LONG");
      expect(setup?.plannedStop).toBeNull();
      expect(setup?.plannedTarget1).toBeNull();
      expect(setup?.plannedEntry.toString()).toBe("20126.75");

      // Chronological order, not the schematic order in
      // docs/tradingview-setup.md's timeline diagram: SIGNAL_ACCEPTED's own
      // signature (EmitSignalAcceptedParams) requires the setupId, so it
      // can only ever be emitted after createSetup's own SETUP_CREATED has
      // already committed - see the deviation noted in this milestone's
      // report.
      const timeline = await inboundWebhookEventsRepository.getFullTradingViewTimeline(event.id);
      expect(timeline.map((e) => e.eventType)).toEqual([
        "WEBHOOK_RECEIVED",
        "WEBHOOK_NORMALIZED",
        "SETUP_CREATED",
        "SIGNAL_ACCEPTED",
      ]);

      expect(setupExpirationQueue.add).toHaveBeenCalledTimes(1);
      expect(publishRealtimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "setup.created", setupId: setup!.id }),
      );

      // Simulate BullMQ redelivering the same job (e.g. after a transient
      // infra blip that still let the first attempt fully complete) -
      // idempotency-on-retry must short-circuit before creating anything.
      await processor.process({ data: { inboundWebhookEventId: event.id } } as never);

      const setupCountForThisWebhook = await prisma.setup.count({ where: { id: setup!.id } });
      expect(setupCountForThisWebhook).toBe(1);
      const totalSetupsForThisSnapshot = await prisma.setup.count({
        where: { marketSnapshotId: setup!.marketSnapshotId },
      });
      expect(totalSetupsForThisSnapshot).toBe(1);
    },
  );

  it("rejects with UNKNOWN_INSTRUMENT for an exchange/symbol with no TradingViewInstrumentMapping (mirrors fixtures/tradingview/unknown-instrument.json)", async () => {
    const payload = makeValidV1Payload({
      exchange: "NYMEX",
      symbol: "CL1!",
      barTime: `2027-09-${10 + Math.floor(Math.random() * 15)}T03:00:00.000Z`,
    });
    const fingerprint = computeTradingViewFingerprint(payload);

    const { event } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 1,
      rawPayload: payload,
      fingerprint,
    });
    await inboundWebhookEventsRepository.markInboundWebhookEventQueued(event.id);

    await processor.process({ data: { inboundWebhookEventId: event.id } } as never);

    const rejected = await inboundWebhookEventsRepository.getInboundWebhookEvent(event.id);
    expect(rejected?.processingStatus).toBe("REJECTED");
    expect(rejected?.failureCode).toBe("UNKNOWN_INSTRUMENT");
    expect(rejected?.setupId).toBeNull();
  });

  it("rejects with UNKNOWN_STRATEGY_VERSION for a strategyKey/strategyVersion with no matching StrategyVersion (mirrors fixtures/tradingview/unknown-strategy.json)", async () => {
    const payload = makeValidV1Payload({
      strategyKey: `nonexistent-strategy-${randomUUID().slice(0, 8)}`,
      strategyVersion: "9.9.9",
      barTime: `2027-10-${10 + Math.floor(Math.random() * 15)}T03:15:00.000Z`,
    });
    const fingerprint = computeTradingViewFingerprint(payload);

    const { event } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 1,
      rawPayload: payload,
      fingerprint,
    });
    await inboundWebhookEventsRepository.markInboundWebhookEventQueued(event.id);

    await processor.process({ data: { inboundWebhookEventId: event.id } } as never);

    const rejected = await inboundWebhookEventsRepository.getInboundWebhookEvent(event.id);
    expect(rejected?.processingStatus).toBe("REJECTED");
    expect(rejected?.failureCode).toBe("UNKNOWN_STRATEGY_VERSION");
    expect(rejected?.setupId).toBeNull();
  });
});
