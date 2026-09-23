import { Decimal } from "decimal.js";
import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SendNotificationJobPayload } from "@trading-copilot/shared-types";
import { instrumentsRepository, marketSnapshotsRepository, prisma, setupsRepository } from "@trading-copilot/database";
import { createRedisConnectionOptions } from "../common/redis-connection";
import { NotificationService } from "./notification.service";

/**
 * Milestone 6, Task 15: proves the full NotificationService.requestNotification
 * path (real Postgres idempotency + real BullMQ enqueue, not either one
 * mocked) genuinely converges under real concurrency, not just each layer
 * in isolation. packages/database/src/notification-idempotency.integration.test.ts
 * (Task 4) already proves requestOrRetryNotification's DB-row idempotency
 * under 10-way concurrency; apps/api/src/screenshots/screenshot.service.redis.test.ts
 * (Milestone 5) already proves enqueueJobIfNeeded's real-BullMQ job-state
 * behavior. Neither exercises both layers together through two genuinely
 * simultaneous calls into the actual orchestrating service — this file
 * closes that gap for notifications specifically, per the plan's own Task
 * 15 requirement.
 *
 * Guarded by both DATABASE_URL (writes a real Setup/MarketSnapshot/
 * NotificationDelivery) and REDIS_URL (see screenshot.service.redis.test.ts's
 * doc comment for why REDIS_URL must be explicitly this project's Redis,
 * never the unguarded localhost:6379 default).
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)(
  "NotificationService.requestNotification concurrency (real Postgres + real BullMQ)",
  () => {
    const queueName = `notification-send-concurrency-test-${Date.now()}`;
    let queue: Queue<SendNotificationJobPayload>;
    let service: NotificationService;

    beforeEach(() => {
      queue = new Queue(queueName, { connection: createRedisConnectionOptions() });
      service = new NotificationService(queue);
    });

    afterEach(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });

    async function seededSetup() {
      const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
      if (!instrument) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

      const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
      if (!strategy) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

      const strategyVersion = await prisma.strategyVersion.findUnique({
        where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
      });
      if (!strategyVersion) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

      const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
        instrumentId: instrument.id,
        timestamp: new Date(),
        timeframe: "1h",
        metadata: { test: "notification-service-concurrency" },
      });

      const setup = await setupsRepository.createSetup({
        instrumentId: instrument.id,
        strategyId: strategy.id,
        strategyVersionId: strategyVersion.id,
        marketSnapshotId: snapshot.id,
        direction: "LONG",
        source: "MANUAL_TEST",
        plannedEntry: new Decimal("100"),
        plannedStop: new Decimal("95"),
        plannedTarget1: new Decimal("110"),
        metadata: { test: "notification-service-concurrency" },
      });

      return setup;
    }

    it(
      "two simultaneous requestNotification(setupId, 'SETUP_READY') calls converge on exactly one NotificationDelivery row and one BullMQ job",
      async () => {
        const setup = await seededSetup();

        // Genuinely concurrent, not sequential-then-assert: both calls fire
        // before either has a chance to observe the other's result.
        await Promise.all([
          service.requestNotification(setup.id, "SETUP_READY"),
          service.requestNotification(setup.id, "SETUP_READY"),
        ]);

        const rows = await prisma.notificationDelivery.findMany({
          where: { setupId: setup.id, notificationType: "SETUP_READY" },
        });
        expect(rows).toHaveLength(1);

        const waiting = await queue.getWaiting();
        const active = await queue.getActive();
        const jobsForThisNotification = [...waiting, ...active].filter((j) => j.id === rows[0]?.id);
        expect(jobsForThisNotification).toHaveLength(1);
      },
      15_000,
    );

    it(
      "a third requestNotification call after the row already exists (not FAILED) does not enqueue a second job",
      async () => {
        const setup = await seededSetup();

        await service.requestNotification(setup.id, "SETUP_READY");
        const rows = await prisma.notificationDelivery.findMany({
          where: { setupId: setup.id, notificationType: "SETUP_READY" },
        });
        expect(rows).toHaveLength(1);

        // The row is QUEUED (nothing has consumed the job in this test), so
        // this call takes the "alreadyInFlight but still QUEUED" branch and
        // re-runs enqueueNotificationIfNeeded, which must see the existing
        // waiting job and skip re-adding, not add a duplicate.
        await service.requestNotification(setup.id, "SETUP_READY");

        const rowsAfter = await prisma.notificationDelivery.findMany({
          where: { setupId: setup.id, notificationType: "SETUP_READY" },
        });
        expect(rowsAfter).toHaveLength(1);

        const waiting = await queue.getWaiting();
        expect(waiting.filter((j) => j.id === rows[0]?.id)).toHaveLength(1);
      },
      15_000,
    );
  },
);
