import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { Test } from "@nestjs/testing";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trading-copilot/database";
import { TRADINGVIEW_WEBHOOK_QUEUE, type TradingViewWebhookJobPayload } from "@trading-copilot/shared-types";
import { createRedisConnectionOptions } from "../common/redis-connection";
import { TradingViewWebhookModule } from "./tradingview-webhook.module";

/**
 * Real end-to-end exercise of POST /webhooks/tradingview against a real
 * (test) Postgres and Redis - a genuine HTTP request through the actual
 * controller/service/repository stack, not a reimplementation of it. This
 * stops at "job enqueued onto a real BullMQ queue": actually running
 * apps/worker's BullMQ consumer is covered separately in
 * apps/worker/src/tradingview-webhook/tradingview-webhook.processor.integration.test.ts,
 * which exercises the real processor against the same live database,
 * because apps/api and apps/worker are separate deployables (see
 * docs/architecture.md) - apps/api has no dependency on apps/worker's
 * code, by design, so a single in-process test spanning both would violate
 * that boundary. Together the two files cover the full documented pipeline
 * end to end.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)(
  "POST /webhooks/tradingview (live Postgres + Redis)",
  () => {
    let app: INestApplication;
    let baseUrl: string;
    let queue: Queue<TradingViewWebhookJobPayload>;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({ connection: createRedisConnectionOptions() }),
          TradingViewWebhookModule,
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      await app.listen(0);

      const address = app.getHttpServer().address();
      const port = typeof address === "string" ? address : address?.port;
      baseUrl = `http://127.0.0.1:${port}`;
      queue = app.get(getQueueToken(TRADINGVIEW_WEBHOOK_QUEUE));
    });

    afterAll(async () => {
      await app.close();
    });

    function makeValidLongPayload() {
      // A fresh barTime each run keeps the fingerprint unique across test
      // runs (fingerprint includes barTime - see computeTradingViewFingerprint).
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
        barTime: `2099-01-01T00:00:00.000Z`,
        firedAt: new Date().toISOString(),
        metadata: { e2eTestId: randomUUID() },
        open: "20123.25",
        high: "20128.50",
        low: "20120.00",
        close: "20126.75",
        volume: "1043",
      };
    }

    it(
      "valid v1 payload -> 202 QUEUED, persists an InboundWebhookEvent, enqueues exactly one job; " +
        "identical re-delivery -> 202 wasDuplicate, no second row, no second job",
      async () => {
        // Unique barTime per test invocation so re-runs of this suite never
        // collide with a previous run's fingerprint.
        const payload = { ...makeValidLongPayload(), barTime: new Date(Date.now()).toISOString() };

        const firstResponse = await fetch(`${baseUrl}/webhooks/tradingview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(firstResponse.status).toBe(202);
        const firstBody = (await firstResponse.json()) as { id: string; processingStatus: string };
        expect(firstBody.processingStatus).toBe("QUEUED");

        const row = await prisma.inboundWebhookEvent.findUnique({ where: { id: firstBody.id } });
        expect(row).not.toBeNull();
        expect(row?.processingStatus).toBe("QUEUED");

        const jobsAfterFirst = await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
        expect(jobsAfterFirst.filter((job) => job.data.inboundWebhookEventId === firstBody.id)).toHaveLength(1);

        const secondResponse = await fetch(`${baseUrl}/webhooks/tradingview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(secondResponse.status).toBe(202);
        const secondBody = (await secondResponse.json()) as {
          id: string;
          processingStatus: string;
          wasDuplicate?: boolean;
        };
        expect(secondBody.id).toBe(firstBody.id);
        expect(secondBody.wasDuplicate).toBe(true);

        const rowCount = await prisma.inboundWebhookEvent.count({ where: { fingerprint: row!.fingerprint } });
        expect(rowCount).toBe(1);

        const jobsAfterDuplicate = await queue.getJobs([
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
        ]);
        expect(
          jobsAfterDuplicate.filter((job) => job.data.inboundWebhookEventId === firstBody.id),
        ).toHaveLength(1);
      },
    );

    it("malformed v1 payload (mirrors fixtures/tradingview/malformed.json) -> 400 synchronously, nothing persisted", async () => {
      const beforeCount = await prisma.inboundWebhookEvent.count();

      const response = await fetch(`${baseUrl}/webhooks/tradingview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          source: "TRADINGVIEW",
          strategyKey: "ema-trend-pullback",
          strategyVersion: "1.0.0",
          exchange: "CME",
          symbol: "NQ1!",
          timeframe: "5",
          signal: "SETUP_CANDIDATE",
          direction: "SIDEWAYS",
          barTime: "not-a-valid-timestamp",
          firedAt: new Date().toISOString(),
          open: "20100.00",
          high: "1e5",
          low: "20090.00",
          close: "not-a-number",
          volume: "-50",
          metadata: {},
        }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { issues: unknown[] };
      expect(Array.isArray(body.issues)).toBe(true);
      expect(body.issues.length).toBeGreaterThan(0);

      expect(await prisma.inboundWebhookEvent.count()).toBe(beforeCount);
    });

    it("invalid envelope (missing schemaVersion) -> 400 synchronously, nothing persisted", async () => {
      const beforeCount = await prisma.inboundWebhookEvent.count();

      const response = await fetch(`${baseUrl}/webhooks/tradingview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "TRADINGVIEW", foo: "bar" }),
      });

      expect(response.status).toBe(400);
      expect(await prisma.inboundWebhookEvent.count()).toBe(beforeCount);
    });

    it("unsupported schemaVersion (mirrors fixtures/tradingview/unsupported-schema.json) -> 202 UNSUPPORTED, persisted, never enqueued", async () => {
      const response = await fetch(`${baseUrl}/webhooks/tradingview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 2,
          source: "TRADINGVIEW",
          strategyKey: "ema-trend-pullback",
          strategyVersion: "1.0.0",
          exchange: "CME",
          symbol: "NQ1!",
          note: "hypothetical future payload shape",
          signal: "SETUP_CANDIDATE",
          direction: "LONG",
          barTime: new Date().toISOString(),
        }),
      });

      expect(response.status).toBe(202);
      const body = (await response.json()) as { id: string; processingStatus: string };
      expect(body.processingStatus).toBe("UNSUPPORTED");

      const row = await prisma.inboundWebhookEvent.findUnique({ where: { id: body.id } });
      expect(row?.processingStatus).toBe("UNSUPPORTED");
      expect(row?.failureCode).toBe("UNSUPPORTED_SCHEMA_VERSION");

      const jobs = await queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
      expect(jobs.filter((job) => job.data.inboundWebhookEventId === body.id)).toHaveLength(0);
    });

    it("GET /webhooks/tradingview/events/:id returns the persisted event, 404 for an unknown id", async () => {
      const created = await fetch(`${baseUrl}/webhooks/tradingview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...makeValidLongPayload(), barTime: new Date().toISOString() }),
      });
      const createdBody = (await created.json()) as { id: string };

      const getResponse = await fetch(`${baseUrl}/webhooks/tradingview/events/${createdBody.id}`);
      expect(getResponse.status).toBe(200);
      const getBody = (await getResponse.json()) as { id: string };
      expect(getBody.id).toBe(createdBody.id);

      const missingResponse = await fetch(`${baseUrl}/webhooks/tradingview/events/${randomUUID()}`);
      expect(missingResponse.status).toBe(404);
    });
  },
);
