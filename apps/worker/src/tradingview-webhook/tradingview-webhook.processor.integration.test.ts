import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboundWebhookEventsRepository,
  marketSnapshotsRepository,
  prisma,
  setupsRepository,
  strategiesRepository,
  tradingViewInstrumentMappingsRepository,
} from "@trading-copilot/database";
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
      // A wide, effectively-collision-free random range - the fingerprint
      // (and now Setup.sourceWebhookEventId's uniqueness) is keyed off this,
      // so two tests must never accidentally share one.
      barTime: new Date(
        Date.UTC(
          2027,
          Math.floor(Math.random() * 12),
          1 + Math.floor(Math.random() * 28),
          Math.floor(Math.random() * 24),
          Math.floor(Math.random() * 60),
          Math.floor(Math.random() * 60),
        ),
      ).toISOString(),
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

  it(
    "does not create a second Setup when a retry finds the event already has a Setup from a " +
      "prior attempt that crashed before reaching PROCESSED (regression: a BullMQ retry policy " +
      "existing does not, by itself, guarantee this - see Setup.sourceWebhookEventId)",
    async () => {
      const payload = makeValidV1Payload();
      const fingerprint = computeTradingViewFingerprint(payload);

      const { event } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: payload,
        fingerprint,
      });
      await inboundWebhookEventsRepository.markInboundWebhookEventQueued(event.id);
      await inboundWebhookEventsRepository.markInboundWebhookEventProcessing(event.id);

      // Manually replicate exactly what the processor does up to (and
      // including) Setup creation, then stop - simulating a crash between
      // createSetup succeeding and the event being marked PROCESSED. The
      // event is deliberately left at PROCESSING (not a status
      // ALREADY_RESOLVED_STATUSES would skip).
      const instrument = await tradingViewInstrumentMappingsRepository.resolveInstrumentMapping(
        payload.exchange,
        payload.symbol,
      );
      expect(
        instrument,
        "expected the seeded CME/NQ1! TradingViewInstrumentMapping to exist (pnpm db:seed)",
      ).not.toBeNull();
      const resolved = await strategiesRepository.findStrategyVersionByKeyAndVersion(
        payload.strategyKey,
        payload.strategyVersion,
      );
      expect(resolved).not.toBeNull();
      const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
        instrumentId: instrument!.id,
        timestamp: new Date(payload.barTime),
        timeframe: "5m",
        metadata: { integrationTest: "retry-before-processed" },
      });
      const preCreatedSetup = await setupsRepository.createSetup({
        instrumentId: instrument!.id,
        strategyId: resolved!.strategy.id,
        strategyVersionId: resolved!.strategyVersion.id,
        marketSnapshotId: snapshot.id,
        direction: payload.direction,
        source: "TRADINGVIEW",
        plannedEntry: new Decimal(payload.close),
        metadata: { inboundWebhookEventId: event.id },
        sourceWebhookEventId: event.id,
      });
      // The real processor emits SIGNAL_ACCEPTED right after createSetup
      // succeeds, still before the simulated crash point (scheduling
      // expiration / marking PROCESSED) - replicate that here too so the
      // "prior attempt" state this test sets up matches what a genuine
      // partial run actually leaves behind.
      await inboundWebhookEventsRepository.emitSignalAccepted(event.id, {
        setupId: preCreatedSetup.id,
        instrumentId: instrument!.id,
        strategyId: resolved!.strategy.id,
        strategyVersionId: resolved!.strategyVersion.id,
      });

      // The actual retry: the processor must find and reuse preCreatedSetup,
      // never call createSetup a second time for this event.
      await processor.process({ data: { inboundWebhookEventId: event.id } } as never);

      const recovered = await inboundWebhookEventsRepository.getInboundWebhookEvent(event.id);
      expect(recovered?.processingStatus).toBe("PROCESSED");
      expect(recovered?.setupId).toBe(preCreatedSetup.id);

      const setupCount = await prisma.setup.count({ where: { sourceWebhookEventId: event.id } });
      expect(setupCount).toBe(1);

      // The recovery path must still schedule the expiration job (it may
      // not have been scheduled before the simulated crash) but must not
      // re-announce "setup.created" for a Setup the dashboard may already
      // know about from before the crash.
      expect(setupExpirationQueue.add).toHaveBeenCalledTimes(1);
      expect(publishRealtimeEvent).not.toHaveBeenCalled();

      // Only one SETUP_CREATED/SIGNAL_ACCEPTED pair exists - the recovery
      // path never re-emits them for the Setup it reused.
      const timeline = await inboundWebhookEventsRepository.getFullTradingViewTimeline(event.id);
      expect(timeline.filter((e) => e.eventType === "SETUP_CREATED")).toHaveLength(1);
      expect(timeline.filter((e) => e.eventType === "SIGNAL_ACCEPTED")).toHaveLength(1);
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
