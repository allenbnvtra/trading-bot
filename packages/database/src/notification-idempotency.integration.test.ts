import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { prisma } from "./client";
import * as instrumentsRepository from "./repositories/instruments";
import * as marketSnapshotsRepository from "./repositories/market-snapshots";
import {
  markNotificationFailed,
  markNotificationSending,
  markNotificationSent,
  requestOrRetryNotification,
} from "./repositories/notification-deliveries";
import * as setupsRepository from "./repositories/setups";

/**
 * Milestone 6, Task 4: end-to-end proof, against a real Postgres database,
 * that requestOrRetryNotification's idempotency guarantee genuinely holds
 * under real concurrency — mirrors screenshot-immutability.integration.
 * test.ts's structure exactly (the same class of proof for TradeScreenshot).
 * The `@@unique([setupId, notificationType, templateVersion])` constraint on
 * NotificationDelivery (see prisma/schema.prisma) is the actual guarantee;
 * this file exists to verify it holds rather than assume it. Requires
 * DATABASE_URL and the Milestone 1 seed (`pnpm db:seed`).
 */
describe.skipIf(!process.env.DATABASE_URL)("notification-deliveries idempotency (live Postgres)", () => {
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
      metadata: { test: "notification-idempotency" },
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
      metadata: { test: "notification-idempotency" },
    });

    return { instrument, strategy, strategyVersion, snapshot, setup };
  }

  it("10 concurrent requestOrRetryNotification calls for the same (setupId, notificationType, templateVersion) converge on exactly one row", async () => {
    const { setup } = await seededSetup();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        requestOrRetryNotification({
          setupId: setup.id,
          provider: "CONSOLE",
          notificationType: "SETUP_READY",
          templateVersion: "1.0.0",
        }),
      ),
    );

    const ids = new Set(results.map((r) => r.notification.id));
    expect(ids.size).toBe(1);

    const rows = await prisma.notificationDelivery.findMany({
      where: { setupId: setup.id, notificationType: "SETUP_READY" },
    });
    expect(rows).toHaveLength(1);

    // Exactly one of the ten calls actually created the row; the other nine
    // observed it, never a second row.
    const flags = results.map((r) => r.alreadyInFlight);
    expect(flags.filter((f) => f === false)).toHaveLength(1);
    expect(flags.filter((f) => f === true)).toHaveLength(9);
  });

  it("a FAILED notification can be retried and reaches SENT without ever creating a second row", async () => {
    const { setup } = await seededSetup();
    const requestInput = {
      setupId: setup.id,
      provider: "CONSOLE" as const,
      notificationType: "SETUP_READY" as const,
      templateVersion: "1.0.0",
    };

    const { notification: first } = await requestOrRetryNotification(requestInput);
    await markNotificationSending(first.id);
    await markNotificationFailed(first.id, {
      failureCode: "TEMPORARY_NETWORK_ERROR",
      failureMessage: "connect ETIMEDOUT",
    });

    const { notification: retried, alreadyInFlight } = await requestOrRetryNotification(requestInput);
    expect(alreadyInFlight).toBe(false);
    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("QUEUED");
    expect(retried.failureCode).toBeNull();
    expect(retried.failureMessage).toBeNull();

    await markNotificationSending(retried.id);
    const sent = await markNotificationSent(retried.id, { externalMessageId: "42" });
    expect(sent.status).toBe("SENT");
    expect(sent.externalMessageId).toBe("42");

    const rows = await prisma.notificationDelivery.findMany({ where: { setupId: setup.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
  });

  it("two genuinely concurrent requests, one FAILED-retry race, still converge on one row (real Promise.all, real Postgres)", async () => {
    const { setup } = await seededSetup();
    const requestInput = {
      setupId: setup.id,
      provider: "CONSOLE" as const,
      notificationType: "SETUP_PREPARE" as const,
      templateVersion: "1.0.0",
    };

    const { notification: created } = await requestOrRetryNotification(requestInput);
    await markNotificationSending(created.id);
    await markNotificationFailed(created.id, {
      failureCode: "TEMPORARY_NETWORK_ERROR",
      failureMessage: "connect ETIMEDOUT",
    });

    const [a, b] = await Promise.all([
      requestOrRetryNotification(requestInput),
      requestOrRetryNotification(requestInput),
    ]);

    expect(a.notification.id).toBe(created.id);
    expect(b.notification.id).toBe(created.id);

    const rows = await prisma.notificationDelivery.findMany({
      where: { setupId: setup.id, notificationType: "SETUP_PREPARE" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("QUEUED");
  });

  it("unrelated notificationType/templateVersion for the same setup do not collide", async () => {
    const { setup } = await seededSetup();

    const a = await requestOrRetryNotification({
      setupId: setup.id,
      provider: "CONSOLE",
      notificationType: "SETUP_PREPARE",
      templateVersion: "1.0.0",
    });
    const b = await requestOrRetryNotification({
      setupId: setup.id,
      provider: "CONSOLE",
      notificationType: "SETUP_READY",
      templateVersion: "1.0.0",
    });
    const c = await requestOrRetryNotification({
      setupId: setup.id,
      provider: "CONSOLE",
      notificationType: "SETUP_PREPARE",
      templateVersion: "2.0.0",
    });

    const ids = new Set([a.notification.id, b.notification.id, c.notification.id]);
    expect(ids.size).toBe(3);

    const rows = await prisma.notificationDelivery.findMany({ where: { setupId: setup.id } });
    expect(rows).toHaveLength(3);
  });
});
