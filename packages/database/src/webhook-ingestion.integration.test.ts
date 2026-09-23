import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { prisma } from "./client";
import { NotFoundError } from "./errors";
import * as inboundWebhookEventsRepository from "./repositories/inbound-webhook-events";
import * as instrumentsRepository from "./repositories/instruments";
import * as marketSnapshotsRepository from "./repositories/market-snapshots";
import * as setupsRepository from "./repositories/setups";
import * as strategiesRepository from "./repositories/strategies";
import * as tradingViewInstrumentMappingsRepository from "./repositories/tradingview-instrument-mappings";

/**
 * Milestone 3: TradingView webhook ingestion, end-to-end against a real
 * Postgres database. Requires DATABASE_URL and the Milestone 1 seed
 * (`pnpm db:seed`) to have been run at least once, since it looks up the
 * seeded GENFUT1 instrument and ema-trend-pullback/1.0.0 strategy version
 * rather than fabricating its own (see journal.integration.test.ts, which
 * this file mirrors for Milestone 2).
 */
describe.skipIf(!process.env.DATABASE_URL)("TradingView webhook ingestion (live Postgres)", () => {
  it("createInboundWebhookEvent is idempotent under genuine concurrent delivery of an identical fingerprint", async () => {
    const fingerprint = `concurrency-test-${randomUUID()}`;
    const input = {
      provider: "TRADINGVIEW" as const,
      schemaVersion: 1,
      rawPayload: { integrationTest: "concurrency" },
      fingerprint,
    };

    // Two requests racing with the *identical* fingerprint: the database
    // unique constraint, not application logic, guarantees only one create
    // ever succeeds.
    const [resultA, resultB] = await Promise.all([
      inboundWebhookEventsRepository.createInboundWebhookEvent(input),
      inboundWebhookEventsRepository.createInboundWebhookEvent(input),
    ]);

    const rows = await prisma.inboundWebhookEvent.findMany({ where: { fingerprint } });
    expect(rows).toHaveLength(1);

    const duplicateFlags = [resultA.wasDuplicate, resultB.wasDuplicate].sort();
    expect(duplicateFlags).toEqual([false, true]);
    expect(resultA.event.id).toBe(resultB.event.id);
    expect(resultA.event.id).toBe(rows[0]!.id);

    // The duplicate-loser's WEBHOOK_DUPLICATE_DETECTED must be correlated to
    // the *existing* (winning) row, and no second row was ever inserted.
    const timeline = await inboundWebhookEventsRepository.getInboundWebhookEventTimeline(rows[0]!.id);
    expect(timeline.map((event) => event.eventType)).toEqual([
      "WEBHOOK_RECEIVED",
      "WEBHOOK_DUPLICATE_DETECTED",
    ]);
  });

  it(
    "full lifecycle: create -> processing -> processed, reconstructed via getFullTradingViewTimeline",
    async () => {
      const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange(
        "GENFUT1",
        "SIM-FUT",
      );
      expect(instrument, "expected the Milestone 1 seed to have run (pnpm db:seed)").not.toBeNull();
      if (!instrument) return;

      const resolved = await strategiesRepository.findStrategyVersionByKeyAndVersion(
        "ema-trend-pullback",
        "1.0.0",
      );
      expect(resolved).not.toBeNull();
      if (!resolved) return;
      const { strategy, strategyVersion } = resolved;

      const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
        instrumentId: instrument.id,
        timestamp: new Date("2024-04-01T08:00:00.000Z"),
        timeframe: "5m",
        metadata: { integrationTest: true },
      });

      // A TRADINGVIEW-sourced Setup can begin with only a candidate entry,
      // plannedStop/plannedTarget1 deliberately omitted.
      const setup = await setupsRepository.createSetup({
        instrumentId: instrument.id,
        strategyId: strategy.id,
        strategyVersionId: strategyVersion.id,
        marketSnapshotId: snapshot.id,
        direction: "LONG",
        source: "TRADINGVIEW",
        plannedEntry: new Decimal("5300"),
        metadata: { integrationTest: true },
      });

      const fingerprint = `lifecycle-test-${randomUUID()}`;
      const created = await inboundWebhookEventsRepository.createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: { integrationTest: true },
        fingerprint,
      });
      expect(created.wasDuplicate).toBe(false);
      expect(created.event.processingStatus).toBe("RECEIVED");

      await inboundWebhookEventsRepository.markInboundWebhookEventQueued(created.event.id);
      const processing = await inboundWebhookEventsRepository.markInboundWebhookEventProcessing(
        created.event.id,
      );
      expect(processing.processingStatus).toBe("PROCESSING");
      expect(processing.processingStartedAt).not.toBeNull();

      await inboundWebhookEventsRepository.emitWebhookNormalized(created.event.id);

      const processed = await inboundWebhookEventsRepository.markInboundWebhookEventProcessed(
        created.event.id,
        { normalizedPayload: { integrationTest: true }, setupId: setup.id },
      );
      expect(processed.processingStatus).toBe("PROCESSED");
      expect(processed.setupId).toBe(setup.id);

      await inboundWebhookEventsRepository.emitSignalAccepted(created.event.id, {
        setupId: setup.id,
        instrumentId: instrument.id,
        strategyId: strategy.id,
        strategyVersionId: strategyVersion.id,
      });

      // Setup's own lifecycle trail (correlated on setup.id) continues
      // independently, per docs/trade-journal-design.md.
      await setupsRepository.transitionSetupStatus(setup.id, { status: "PREPARE" });

      const timeline = await inboundWebhookEventsRepository.getFullTradingViewTimeline(created.event.id);
      const eventTypes = timeline.map((event) => event.eventType);

      // Webhook-side trail (correlated on the webhook event's own id).
      expect(eventTypes).toContain("WEBHOOK_RECEIVED");
      expect(eventTypes).toContain("WEBHOOK_NORMALIZED");
      expect(eventTypes).toContain("SIGNAL_ACCEPTED");
      // Setup's own trail (correlated on setup.id), merged in.
      expect(eventTypes).toContain("SETUP_CREATED");

      // Merged and ordered by timestamp ascending.
      for (let i = 1; i < timeline.length; i += 1) {
        expect(timeline[i]!.timestamp.getTime()).toBeGreaterThanOrEqual(
          timeline[i - 1]!.timestamp.getTime(),
        );
      }

      // Without a setupId, getFullTradingViewTimeline degrades to just the
      // webhook's own timeline (still-processing / rejected-before-setup case).
      const fingerprint2 = `lifecycle-no-setup-${randomUUID()}`;
      const createdNoSetup = await inboundWebhookEventsRepository.createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: { integrationTest: true },
        fingerprint: fingerprint2,
      });
      const noSetupTimeline = await inboundWebhookEventsRepository.getFullTradingViewTimeline(
        createdNoSetup.event.id,
      );
      expect(noSetupTimeline.map((event) => event.eventType)).toEqual(["WEBHOOK_RECEIVED"]);
    },
  );

  it("getFullTradingViewTimeline breaks a timestamp tie using sequence, not concatenation order", async () => {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange(
      "GENFUT1",
      "SIM-FUT",
    );
    expect(instrument, "expected the Milestone 1 seed to have run (pnpm db:seed)").not.toBeNull();
    if (!instrument) return;

    const resolved = await strategiesRepository.findStrategyVersionByKeyAndVersion(
      "ema-trend-pullback",
      "1.0.0",
    );
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    const { strategy, strategyVersion } = resolved;

    const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: instrument.id,
      timestamp: new Date("2024-04-01T08:00:00.000Z"),
      timeframe: "5m",
      metadata: { integrationTest: true },
    });
    const setup = await setupsRepository.createSetup({
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      marketSnapshotId: snapshot.id,
      direction: "LONG",
      source: "TRADINGVIEW",
      plannedEntry: new Decimal("5300"),
      metadata: { integrationTest: true },
    });

    const fingerprint = `tie-break-test-${randomUUID()}`;
    const created = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 1,
      rawPayload: { integrationTest: true },
      fingerprint,
    });
    await inboundWebhookEventsRepository.markInboundWebhookEventProcessed(created.event.id, {
      normalizedPayload: { integrationTest: true },
      setupId: setup.id,
    });

    const tiedTimestamp = new Date("2024-05-01T00:00:00.000Z");

    // Insert the setup-side row first (lower `sequence`), then the
    // webhook-side row second (higher `sequence`), both sharing an
    // identical `timestamp`. The old implementation concatenated
    // `[...webhookRows, ...setupRows]` before sorting by timestamp alone, so
    // a stable sort would have kept the webhook-side row first regardless
    // of insertion order — this proves the merge now uses `sequence`, not
    // which array a row came from.
    const setupRow = await prisma.journalEvent.create({
      data: {
        eventType: "SETUP_APPROVED",
        entityType: "SETUP",
        entityId: setup.id,
        correlationId: setup.id,
        timestamp: tiedTimestamp,
      },
    });
    const webhookRow = await prisma.journalEvent.create({
      data: {
        eventType: "WEBHOOK_NORMALIZED",
        entityType: "INBOUND_WEBHOOK_EVENT",
        entityId: created.event.id,
        correlationId: created.event.id,
        timestamp: tiedTimestamp,
      },
    });
    expect(webhookRow.sequence).toBeGreaterThan(setupRow.sequence);

    const timeline = await inboundWebhookEventsRepository.getFullTradingViewTimeline(created.event.id);
    const tiedEvents = timeline.filter((event) => event.timestamp.getTime() === tiedTimestamp.getTime());
    expect(tiedEvents.map((event) => event.id)).toEqual([setupRow.id, webhookRow.id]);
  });

  it("rejection path: WEBHOOK_RECEIVED then WEBHOOK_REJECTED", async () => {
    const fingerprint = `rejection-test-${randomUUID()}`;
    const created = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 1,
      rawPayload: { integrationTest: true },
      fingerprint,
    });

    const rejected = await inboundWebhookEventsRepository.markInboundWebhookEventRejected(
      created.event.id,
      { failureCode: "UNKNOWN_INSTRUMENT", failureMessage: "no mapping for this exchange/symbol" },
    );
    expect(rejected.processingStatus).toBe("REJECTED");
    expect(rejected.failureCode).toBe("UNKNOWN_INSTRUMENT");
    expect(rejected.processingCompletedAt).not.toBeNull();

    const timeline = await inboundWebhookEventsRepository.getInboundWebhookEventTimeline(
      created.event.id,
    );
    expect(timeline.map((event) => event.eventType)).toEqual(["WEBHOOK_RECEIVED", "WEBHOOK_REJECTED"]);
  });

  it("markInboundWebhookEventUnsupported sets UNSUPPORTED_SCHEMA_VERSION and emits WEBHOOK_REJECTED", async () => {
    const fingerprint = `unsupported-test-${randomUUID()}`;
    const created = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 99,
      rawPayload: { integrationTest: true },
      fingerprint,
    });

    const unsupported = await inboundWebhookEventsRepository.markInboundWebhookEventUnsupported(
      created.event.id,
      { failureMessage: "unsupported schema version 99" },
    );
    expect(unsupported.processingStatus).toBe("UNSUPPORTED");
    expect(unsupported.failureCode).toBe("UNSUPPORTED_SCHEMA_VERSION");

    const timeline = await inboundWebhookEventsRepository.getInboundWebhookEventTimeline(
      created.event.id,
    );
    expect(timeline.map((event) => event.eventType)).toEqual(["WEBHOOK_RECEIVED", "WEBHOOK_REJECTED"]);
  });

  it("markInboundWebhookEventFailed defaults failureCode to INTERNAL_ERROR and emits WEBHOOK_PROCESSING_FAILED", async () => {
    const fingerprint = `failed-test-${randomUUID()}`;
    const created = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 1,
      rawPayload: { integrationTest: true },
      fingerprint,
    });

    const failed = await inboundWebhookEventsRepository.markInboundWebhookEventFailed(
      created.event.id,
      { failureMessage: "unexpected error while processing" },
    );
    expect(failed.processingStatus).toBe("FAILED");
    expect(failed.failureCode).toBe("INTERNAL_ERROR");

    const timeline = await inboundWebhookEventsRepository.getInboundWebhookEventTimeline(
      created.event.id,
    );
    expect(timeline.map((event) => event.eventType)).toEqual([
      "WEBHOOK_RECEIVED",
      "WEBHOOK_PROCESSING_FAILED",
    ]);
  });

  it("throws NotFoundError for lifecycle transitions on a nonexistent InboundWebhookEvent", async () => {
    const bogusId = randomUUID();
    await expect(inboundWebhookEventsRepository.markInboundWebhookEventQueued(bogusId)).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      inboundWebhookEventsRepository.markInboundWebhookEventProcessing(bogusId),
    ).rejects.toThrow(NotFoundError);
    await expect(
      inboundWebhookEventsRepository.markInboundWebhookEventProcessed(bogusId, {
        normalizedPayload: {},
        setupId: randomUUID(),
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      inboundWebhookEventsRepository.markInboundWebhookEventRejected(bogusId, {
        failureCode: "MALFORMED_PAYLOAD",
        failureMessage: "x",
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      inboundWebhookEventsRepository.markInboundWebhookEventUnsupported(bogusId, {
        failureMessage: "x",
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      inboundWebhookEventsRepository.markInboundWebhookEventFailed(bogusId, { failureMessage: "x" }),
    ).rejects.toThrow(NotFoundError);
  });

  describe("findStrategyVersionByKeyAndVersion", () => {
    it("resolves the seeded ema-trend-pullback/1.0.0", async () => {
      const result = await strategiesRepository.findStrategyVersionByKeyAndVersion(
        "ema-trend-pullback",
        "1.0.0",
      );
      expect(result).not.toBeNull();
      expect(result?.strategy.key).toBe("ema-trend-pullback");
      expect(result?.strategyVersion.version).toBe("1.0.0");
    });

    it("returns null when the strategy key itself doesn't resolve", async () => {
      const result = await strategiesRepository.findStrategyVersionByKeyAndVersion(
        "nonexistent-strategy-key",
        "1.0.0",
      );
      expect(result).toBeNull();
    });

    it("returns null when the strategy resolves but the version doesn't", async () => {
      const result = await strategiesRepository.findStrategyVersionByKeyAndVersion(
        "ema-trend-pullback",
        "999.0.0",
      );
      expect(result).toBeNull();
    });
  });

  describe("tradingview instrument mapping", () => {
    it("normalizes exchange/symbol case identically on create and resolve", async () => {
      const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange(
        "GENFUT1",
        "SIM-FUT",
      );
      expect(instrument).not.toBeNull();
      if (!instrument) return;

      const uniqueSymbol = `TEST-SYM-${randomUUID().slice(0, 8)}`;
      await tradingViewInstrumentMappingsRepository.createTradingViewInstrumentMapping({
        exchange: "cme",
        symbol: uniqueSymbol.toLowerCase(),
        instrumentId: instrument.id,
      });

      const resolvedExactCase = await tradingViewInstrumentMappingsRepository.resolveInstrumentMapping(
        "CME",
        uniqueSymbol,
      );
      expect(resolvedExactCase?.id).toBe(instrument.id);

      const resolvedDifferentCase = await tradingViewInstrumentMappingsRepository.resolveInstrumentMapping(
        "  Cme  ",
        uniqueSymbol.toLowerCase(),
      );
      expect(resolvedDifferentCase?.id).toBe(instrument.id);
    });

    it("returns null for an unmapped exchange/symbol rather than guessing", async () => {
      const resolved = await tradingViewInstrumentMappingsRepository.resolveInstrumentMapping(
        "UNMAPPED_EXCHANGE",
        `unmapped-${randomUUID()}`,
      );
      expect(resolved).toBeNull();
    });
  });
});
