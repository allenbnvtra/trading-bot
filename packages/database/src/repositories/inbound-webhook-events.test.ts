import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../client";
import {
  createInboundWebhookEvent,
  findMostRecentInboundWebhookEvent,
  findMostRecentProcessedInboundWebhookEvent,
  markInboundWebhookEventProcessed,
} from "./inbound-webhook-events";
import * as instrumentsRepository from "./instruments";
import * as marketSnapshotsRepository from "./market-snapshots";
import * as strategiesRepository from "./strategies";
import * as setupsRepository from "./setups";

/**
 * findMostRecentInboundWebhookEvent / findMostRecentProcessedInboundWebhookEvent
 * back GET /health's tradingViewIngestion check (see health.service.ts) -
 * dedicated `take: 1` indexed queries rather than listing every row just to
 * read the first one. Run against a real Postgres database, like
 * webhook-ingestion.integration.test.ts, since these are thin
 * `findFirst`/`orderBy` wrappers with no pure logic to isolate from Prisma.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "findMostRecentInboundWebhookEvent / findMostRecentProcessedInboundWebhookEvent (live Postgres)",
  () => {
    // This suite asserts *global* most-recent-row behavior (no `where`
    // filter beyond processingStatus) and deliberately backdates/postdates
    // fixture rows (see below) to control ordering deterministically. Any
    // row left behind after this suite finishes would permanently corrupt
    // that global ordering for other suites sharing this database (e.g.
    // tradingview-webhook.e2e.test.ts's `findFirst({ orderBy: { receivedAt:
    // "desc" } })` assuming the row it just created is the newest) - so
    // fixture rows (tagged by the `most-recent-` fingerprint prefix used
    // throughout this file) are deleted both before this suite runs (in
    // case a previous run crashed before its own cleanup) and after.
    beforeAll(async () => {
      await prisma.inboundWebhookEvent.deleteMany({
        where: { fingerprint: { startsWith: "most-recent-" } },
      });
    });

    afterAll(async () => {
      await prisma.inboundWebhookEvent.deleteMany({
        where: { fingerprint: { startsWith: "most-recent-" } },
      });
    });

    it("findMostRecentInboundWebhookEvent returns the newest event regardless of processingStatus", async () => {
      const olderFingerprint = `most-recent-older-${randomUUID()}`;
      const newerFingerprint = `most-recent-newer-${randomUUID()}`;

      const older = await createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: { fixture: "older" },
        fingerprint: olderFingerprint,
      });
      await prisma.inboundWebhookEvent.update({
        where: { id: older.event.id },
        data: { receivedAt: new Date("2020-01-01T00:00:00.000Z") },
      });

      const newer = await createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: { fixture: "newer" },
        fingerprint: newerFingerprint,
      });
      await prisma.inboundWebhookEvent.update({
        where: { id: newer.event.id },
        data: { receivedAt: new Date("2031-01-01T00:00:00.000Z") },
      });

      const mostRecent = await findMostRecentInboundWebhookEvent();
      expect(mostRecent?.id).toBe(newer.event.id);
    });

    it("findMostRecentProcessedInboundWebhookEvent ignores a newer non-PROCESSED event", async () => {
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

      const processedFingerprint = `most-recent-processed-${randomUUID()}`;
      const failedFingerprint = `most-recent-failed-${randomUUID()}`;

      const processedEvent = await createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: { fixture: "processed" },
        fingerprint: processedFingerprint,
      });
      // Deliberately after "now" (rather than a literal past date), so this
      // outranks every naturally-timestamped row other tests in this suite
      // create with a real `receivedAt` default, while still preceding
      // failedEvent's timestamp below.
      await prisma.inboundWebhookEvent.update({
        where: { id: processedEvent.event.id },
        data: { receivedAt: new Date("2031-06-01T00:00:00.000Z") },
      });

      const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
        instrumentId: instrument.id,
        timestamp: new Date("2024-04-01T08:00:00.000Z"),
        timeframe: "5m",
        metadata: { unitTest: true },
      });

      const setup = await setupsRepository.createSetup({
        instrumentId: instrument.id,
        strategyId: strategy.id,
        strategyVersionId: strategyVersion.id,
        marketSnapshotId: snapshot.id,
        direction: "LONG",
        source: "TRADINGVIEW",
        plannedEntry: new Decimal("5300"),
        metadata: { unitTest: true },
      });
      await markInboundWebhookEventProcessed(processedEvent.event.id, {
        normalizedPayload: { fixture: "processed" },
        setupId: setup.id,
      });

      // A later delivery that ended FAILED (never reached PROCESSED) must
      // not be returned by findMostRecentProcessedInboundWebhookEvent, even
      // though it is the more recent event overall.
      const failedEvent = await createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion: 1,
        rawPayload: { fixture: "failed" },
        fingerprint: failedFingerprint,
      });
      await prisma.inboundWebhookEvent.update({
        where: { id: failedEvent.event.id },
        data: {
          receivedAt: new Date("2032-01-01T00:00:00.000Z"),
          processingStatus: "FAILED",
          processingCompletedAt: new Date("2032-01-01T00:00:01.000Z"),
        },
      });

      const mostRecent = await findMostRecentInboundWebhookEvent();
      expect(mostRecent?.id).toBe(failedEvent.event.id);

      const mostRecentProcessed = await findMostRecentProcessedInboundWebhookEvent();
      expect(mostRecentProcessed?.id).toBe(processedEvent.event.id);
    });
  },
);
