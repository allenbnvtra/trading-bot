import { Prisma } from "@prisma/client";
import type { NotificationProviderType, NotificationType } from "@trading-copilot/shared-types";
import type { NotificationDelivery } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { NotFoundError, NotificationStateError } from "../errors";
import { mapNotificationDelivery } from "../mappers";
import { createJournalEvent } from "./journal-events";

/**
 * Milestone 6: outbound (Telegram, or CONSOLE in development) notification
 * delivery lifecycle for setup-lifecycle events (see docs/notifications.md).
 * Mirrors trade-screenshots.ts's requestOrRetryScreenshot /
 * markScreenshot*'s exact idempotency and atomic-transition patterns — the
 * `@@unique([setupId, notificationType, templateVersion])` constraint on the
 * NotificationDelivery model (see prisma/schema.prisma) is the actual
 * idempotency guarantee, never a check-then-insert.
 */

export interface RequestNotificationInput {
  setupId: string;
  provider: NotificationProviderType;
  notificationType: NotificationType;
  templateVersion: string;
}

/**
 * Any Prisma client-shaped object that supports the `notificationDelivery`
 * delegate — the top-level `prisma` singleton or a `$transaction` callback's
 * `tx` argument. Named distinctly from trade-screenshots.ts's own
 * `ScreenshotPrismaClientOrTx` (same shape/role, different table) to avoid
 * confusing the two incompatible types for a reader jumping between files.
 */
type NotificationPrismaClientOrTx = Pick<Prisma.TransactionClient, "notificationDelivery">;

/**
 * Mirrors trade-screenshots.ts's isUniqueConstraintViolation exactly (and
 * inbound-webhook-events.ts's before it): a type-safe P2002 check that also
 * verifies the violated constraint is actually the one this call cares
 * about. Duplicated rather than imported from trade-screenshots.ts — these
 * are two independent lifecycle repositories and neither should depend on
 * the other's internals (Task 4 brief).
 */
function isUniqueConstraintViolation(error: unknown, fields: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    fields.every((field) => (error.meta!.target as unknown[]).includes(field))
  );
}

function findByIdempotencyKey(tx: NotificationPrismaClientOrTx, input: RequestNotificationInput) {
  return tx.notificationDelivery.findFirst({
    where: {
      setupId: input.setupId,
      notificationType: input.notificationType,
      templateVersion: input.templateVersion,
    },
  });
}

/**
 * Idempotent per (setupId, notificationType, templateVersion) — the same
 * "database constraint, not check-then-insert" pattern as
 * TradeScreenshot/InboundWebhookEvent. A pre-existing non-FAILED row is
 * returned as-is (`alreadyInFlight: true`). A pre-existing FAILED row is
 * reset to QUEUED (a NOTIFICATION_RETRYING journal event is emitted for the
 * reset — mirrors trade-screenshots.ts's SCREENSHOT_RETRIED precedent) and
 * returned for reprocessing.
 *
 * `findFirst` then `create` is not race-free on its own — two concurrent
 * calls can both see no existing row and both attempt `create`. The
 * `@@unique([setupId, notificationType, templateVersion])` constraint is
 * the actual safety net: the loser's `create` throws P2002 inside the
 * transaction, which aborts it; the P2002 is caught *outside* the
 * transaction and the loser re-reads the row the winner just committed and
 * returns that instead — never a second row, never an unhandled rejection.
 */
export async function requestOrRetryNotification(
  input: RequestNotificationInput,
): Promise<{ notification: NotificationDelivery; alreadyInFlight: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await findByIdempotencyKey(tx, input);

      if (existing && existing.status !== "FAILED") {
        return { notification: mapNotificationDelivery(existing), alreadyInFlight: true };
      }

      if (existing) {
        const previousFailureCode = existing.failureCode;
        const result = await tx.notificationDelivery.updateMany({
          where: { id: existing.id, status: "FAILED" },
          data: { status: "QUEUED", failureCode: null, failureMessage: null },
        });

        if (result.count === 0) {
          // Someone else concurrently won the FAILED -> QUEUED reset between
          // our read above and this updateMany. Re-read whatever they left
          // behind rather than treat this call as a fresh winner — mirrors
          // the P2002 catch path below, which does the same thing for the
          // create race.
          const current = await findByIdempotencyKey(tx, input);
          if (!current) {
            // Unreachable in practice: we just observed this row inside the
            // same transaction. Surface a real error rather than fabricate one.
            throw new NotFoundError("NotificationDelivery", existing.id);
          }
          return { notification: mapNotificationDelivery(current), alreadyInFlight: true };
        }

        const retried = await tx.notificationDelivery.findUniqueOrThrow({ where: { id: existing.id } });

        await createJournalEvent(
          {
            eventType: "NOTIFICATION_RETRYING",
            entityType: "NOTIFICATION_DELIVERY",
            entityId: existing.id,
            correlationId: input.setupId,
            metadata: { notificationType: input.notificationType, previousFailureCode },
          },
          tx,
        );

        return { notification: mapNotificationDelivery(retried), alreadyInFlight: false };
      }

      const created = await tx.notificationDelivery.create({
        data: {
          setupId: input.setupId,
          provider: input.provider,
          notificationType: input.notificationType,
          templateVersion: input.templateVersion,
          status: "QUEUED",
        },
      });

      await createJournalEvent(
        {
          eventType: "NOTIFICATION_QUEUED",
          entityType: "NOTIFICATION_DELIVERY",
          entityId: created.id,
          correlationId: input.setupId,
          metadata: { notificationType: input.notificationType },
        },
        tx,
      );

      return { notification: mapNotificationDelivery(created), alreadyInFlight: false };
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error, ["setupId", "notificationType", "templateVersion"])) {
      throw error;
    }
    const winner = await findByIdempotencyKey(prisma, input);
    if (!winner) {
      // Unreachable in practice: a P2002 on this constraint guarantees a
      // matching row exists. Surface the original error rather than
      // fabricate one.
      throw error;
    }
    return { notification: mapNotificationDelivery(winner), alreadyInFlight: true };
  }
}

async function requireNotification(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.notificationDelivery.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("NotificationDelivery", id);
  return row;
}

/**
 * Guarded with an atomic conditional `updateMany` rather than
 * read-then-check-then-`update` — see markScreenshotGenerating's doc
 * comment in trade-screenshots.ts for why the latter is not actually
 * race-free under Postgres READ COMMITTED. QUEUED or RETRYING -> SENDING.
 */
export async function markNotificationSending(id: string): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "SENDING", sendingAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark sending", current.status, "QUEUED or RETRYING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_SENDING",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId ?? id,
        metadata: { notificationType: row.notificationType, attemptCount: row.attemptCount },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

export interface MarkNotificationSentInput {
  externalMessageId: string | null;
}

/** SENDING -> SENT. Throws NotificationStateError from any other state. */
export async function markNotificationSent(
  id: string,
  input: MarkNotificationSentInput,
): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "SENT", sentAt: new Date(), externalMessageId: input.externalMessageId },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark sent", current.status, "SENDING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_SENT",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId ?? id,
        metadata: { notificationType: row.notificationType },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

export interface MarkNotificationFailedInput {
  failureCode: string;
  failureMessage: string;
}

/** Terminal failure — a permanent-classification provider error (invalid token, invalid chat id). Never auto-retried further. SENDING -> FAILED. */
export async function markNotificationFailed(
  id: string,
  input: MarkNotificationFailedInput,
): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "FAILED", failureCode: input.failureCode, failureMessage: input.failureMessage },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark failed", current.status, "SENDING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_FAILED",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId ?? id,
        metadata: { failureCode: input.failureCode, failureMessage: input.failureMessage },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

/** A temporary-classification provider error with BullMQ attempts remaining — the job will retry, this just records the attempt for the audit trail. SENDING -> RETRYING. */
export async function markNotificationRetrying(
  id: string,
  input: MarkNotificationFailedInput,
): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "RETRYING", failureCode: input.failureCode, failureMessage: input.failureMessage },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark retrying", current.status, "SENDING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_RETRYING",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId ?? id,
        metadata: { failureCode: input.failureCode, failureMessage: input.failureMessage },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

/** Mirrors getScreenshot in trade-screenshots.ts — a plain findUnique, used by NotificationSendProcessor to load the full row (setupId, notificationType) from the BullMQ job's id-only payload. */
export async function getById(id: string): Promise<NotificationDelivery | null> {
  const row = await prisma.notificationDelivery.findUnique({ where: { id } });
  return row ? mapNotificationDelivery(row) : null;
}

export async function listNotificationsForSetup(setupId: string): Promise<NotificationDelivery[]> {
  const rows = await prisma.notificationDelivery.findMany({
    where: { setupId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapNotificationDelivery);
}

/** Used by the setup-status policy (INVALIDATED/EXPIRED only notify if a PREPARE/READY notification was previously SENT for this setup). */
export async function findMostRecentSentNotification(
  setupId: string,
  notificationTypes: NotificationType[],
): Promise<NotificationDelivery | null> {
  const row = await prisma.notificationDelivery.findFirst({
    where: { setupId, notificationType: { in: notificationTypes }, status: "SENT" },
    orderBy: { sentAt: "desc" },
  });
  return row ? mapNotificationDelivery(row) : null;
}

/**
 * Backs GET /health's notification check — bounded window so a past
 * incident doesn't report DEGRADED forever. Mirrors
 * countRecentFailedScreenshots exactly.
 */
export async function countRecentFailedNotifications(sinceMinutesAgo: number): Promise<number> {
  const cutoff = new Date(Date.now() - sinceMinutesAgo * 60_000);
  return prisma.notificationDelivery.count({
    where: { status: "FAILED", updatedAt: { gte: cutoff } },
  });
}

/**
 * The single most recent notification that reached SENT, across every
 * setup. Mirrors findMostRecentReadyScreenshot's role for GET /health.
 */
export async function findMostRecentSentNotificationOverall(): Promise<NotificationDelivery | null> {
  const row = await prisma.notificationDelivery.findFirst({
    where: { status: "SENT" },
    orderBy: { sentAt: { sort: "desc", nulls: "last" } },
  });
  return row ? mapNotificationDelivery(row) : null;
}
