import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../client";
import { NotificationStateError } from "../errors";
import {
  markNotificationSending,
  markNotificationSent,
  requestOrRetryNotification,
  type RequestNotificationInput,
} from "./notification-deliveries";

/**
 * Mocked-Prisma unit tests, mirroring candles.test.ts's `vi.mock("../client")`
 * style — this file never touches a real database. `$transaction` is
 * mocked to simply invoke its callback with the same mocked `prisma`
 * object standing in for `tx` (both expose `.notificationDelivery` and
 * `.journalEvent`), which is enough to exercise this module's control flow
 * without a real transaction. The genuine-concurrency proof (real Postgres,
 * real `@@unique` constraint, real races) lives in
 * notification-idempotency.integration.test.ts — mocking `$transaction`
 * here would not exercise the actual race condition this repository exists
 * to close.
 */
vi.mock("../client", () => ({
  prisma: {
    notificationDelivery: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    journalEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

function journalEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    eventType: "NOTIFICATION_QUEUED",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    sequence: 1,
    entityType: "NOTIFICATION_DELIVERY",
    entityId: "notification-1",
    correlationId: "setup-1",
    instrumentId: null,
    strategyId: null,
    strategyVersionId: null,
    metadata: {},
    ...overrides,
  };
}

function mockTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation(((callback: (tx: typeof prisma) => Promise<unknown>) =>
    callback(prisma)) as unknown as typeof prisma.$transaction);
  // createJournalEvent's own return value is unused by every function in
  // this module (it's fire-and-forget for the journal timeline), but it
  // still runs mapJournalEvent(row) on whatever this mock resolves to — a
  // default row here keeps every test from having to stub this separately.
  vi.mocked(prisma.journalEvent.create).mockResolvedValue(journalEventRow() as never);
}

const REQUEST_INPUT: RequestNotificationInput = {
  setupId: "setup-1",
  provider: "CONSOLE",
  notificationType: "SETUP_READY",
  templateVersion: "1.0.0",
};

function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "notification-1",
    setupId: "setup-1",
    tradeId: null,
    tradeSource: null,
    provider: "CONSOLE",
    notificationType: "SETUP_READY",
    templateVersion: "1.0.0",
    status: "QUEUED",
    attemptCount: 0,
    queuedAt: new Date("2026-01-01T00:00:00.000Z"),
    sendingAt: null,
    sentAt: null,
    externalMessageId: null,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("requestOrRetryNotification", () => {
  it("returns the existing row unchanged when one already exists and is not FAILED", async () => {
    mockTransaction();
    const existing = notificationRow({ status: "SENT" });
    vi.mocked(prisma.notificationDelivery.findFirst).mockResolvedValue(existing as never);

    const result = await requestOrRetryNotification(REQUEST_INPUT);

    expect(result.alreadyInFlight).toBe(true);
    expect(result.notification.id).toBe(existing.id);
    expect(result.notification.status).toBe("SENT");
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.update).not.toHaveBeenCalled();
    expect(prisma.journalEvent.create).not.toHaveBeenCalled();
  });

  it("resets a FAILED row back to QUEUED and clears failureCode/failureMessage", async () => {
    mockTransaction();
    const existing = notificationRow({
      status: "FAILED",
      failureCode: "PROVIDER_ERROR",
      failureMessage: "telegram send failed",
    });
    const retried = notificationRow({ status: "QUEUED", failureCode: null, failureMessage: null });
    vi.mocked(prisma.notificationDelivery.findFirst).mockResolvedValue(existing as never);
    vi.mocked(prisma.notificationDelivery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.notificationDelivery.findUniqueOrThrow).mockResolvedValue(retried as never);

    const result = await requestOrRetryNotification(REQUEST_INPUT);

    expect(result.alreadyInFlight).toBe(false);
    expect(result.notification.status).toBe("QUEUED");
    // Guarded by an atomic conditional updateMany keyed on status: "FAILED"
    // (mirroring markNotificationSending/Sent/Failed/Retrying below), not a
    // plain update() keyed only on id — two concurrent retries of the same
    // FAILED row must not both "win".
    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: existing.id, status: "FAILED" },
      data: { status: "QUEUED", failureCode: null, failureMessage: null },
    });
    expect(prisma.notificationDelivery.update).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();

    // NOTIFICATION_RETRYING journal event, correlated onto the Setup, with
    // the previous failureCode recorded (mirrors trade-screenshots.ts's
    // SCREENSHOT_RETRIED precedent exactly).
    expect(prisma.journalEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "NOTIFICATION_RETRYING",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: existing.id,
        correlationId: REQUEST_INPUT.setupId,
        metadata: expect.objectContaining({
          notificationType: REQUEST_INPUT.notificationType,
          previousFailureCode: "PROVIDER_ERROR",
        }),
      }),
    });
  });

  it("loses a concurrent FAILED -> QUEUED reset race and returns the winner's row instead, never throwing", async () => {
    mockTransaction();
    const existing = notificationRow({
      status: "FAILED",
      failureCode: "PROVIDER_ERROR",
      failureMessage: "telegram send failed",
    });
    // Someone else's updateMany already won the FAILED -> QUEUED reset
    // between our findFirst above and this updateMany, so this call's
    // conditional updateMany matches zero rows.
    const winnersRow = notificationRow({ status: "QUEUED", failureCode: null, failureMessage: null });
    vi.mocked(prisma.notificationDelivery.findFirst)
      .mockResolvedValueOnce(existing as never) // inside $transaction: findByIdempotencyKey
      .mockResolvedValueOnce(winnersRow as never); // re-read after the updateMany miss
    vi.mocked(prisma.notificationDelivery.updateMany).mockResolvedValue({ count: 0 } as never);

    const result = await requestOrRetryNotification(REQUEST_INPUT);

    expect(result.alreadyInFlight).toBe(true);
    expect(result.notification.status).toBe("QUEUED");
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.update).not.toHaveBeenCalled();
  });

  it("re-reads and returns the winner's row on a P2002 unique-constraint race, never throwing", async () => {
    mockTransaction();
    const winner = notificationRow();

    // Inside the transaction: no existing row is seen (this call is the
    // loser of the race), so it attempts `create`, which throws the P2002
    // the winner's already-committed row produced.
    vi.mocked(prisma.notificationDelivery.findFirst)
      .mockResolvedValueOnce(null as never) // inside $transaction: findByIdempotencyKey
      .mockResolvedValueOnce(winner as never); // outside, in the P2002 catch: re-read
    vi.mocked(prisma.notificationDelivery.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.0.0",
        meta: { target: ["setupId", "notificationType", "templateVersion"] },
      }) as never,
    );

    const result = await requestOrRetryNotification(REQUEST_INPUT);

    expect(result.alreadyInFlight).toBe(true);
    expect(result.notification.id).toBe(winner.id);
  });
});

describe("markNotificationSending/Sent/Failed/Retrying", () => {
  it("markNotificationSending only transitions a QUEUED or RETRYING row, guarded by updateMany", async () => {
    mockTransaction();
    vi.mocked(prisma.notificationDelivery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.notificationDelivery.findUniqueOrThrow).mockResolvedValue(
      notificationRow({ status: "SENDING", attemptCount: 1 }) as never,
    );

    await markNotificationSending("notification-1");

    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "notification-1", status: { in: ["QUEUED", "RETRYING"] } },
      data: expect.objectContaining({ status: "SENDING" }),
    });
  });

  it("markNotificationSent throws ScreenshotStateError-equivalent (a new NotificationStateError) if the row is not SENDING", async () => {
    mockTransaction();
    vi.mocked(prisma.notificationDelivery.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.notificationDelivery.findUnique).mockResolvedValue(
      notificationRow({ status: "QUEUED" }) as never,
    );

    await expect(markNotificationSent("notification-1", { externalMessageId: null })).rejects.toThrow(
      NotificationStateError,
    );
    await expect(markNotificationSent("notification-1", { externalMessageId: null })).rejects.toThrow(
      "cannot mark sent: NotificationDelivery status is QUEUED, required SENDING",
    );
  });
});
