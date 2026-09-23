import { Prisma } from "@prisma/client";
import type {
  WebhookFailureCode,
  WebhookProcessingStatus,
  WebhookProvider,
} from "@trading-copilot/shared-types";
import type { InboundWebhookEvent, JournalEvent } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { NotFoundError } from "../errors";
import { mapInboundWebhookEvent, mapJournalEvent, type PrismaJournalEventRow } from "../mappers";
import {
  createJournalEvent,
  getSetupTimelineRaw,
  listJournalEventRows,
  mergeJournalEventRows,
} from "./journal-events";

/**
 * Milestone 3: TradingView webhook ingestion (see docs/tradingview-setup.md
 * and .claude/agents/data-engineer.md). `InboundWebhookEvent` is the durable
 * record of one physical webhook delivery; `fingerprint`'s database
 * `@unique` constraint (not a "check then insert" pattern) is what makes a
 * duplicate physical delivery safe under real concurrency, see
 * `createInboundWebhookEvent` below.
 *
 * Every event this module emits before a Setup exists is correlated on the
 * InboundWebhookEvent's own id, distinct from a Setup's own lifecycle
 * timeline (correlated on `setup.id`, per setups.ts). `emitSignalAccepted`
 * is the one exception worth calling out explicitly: it targets `SETUP` as
 * its entityType (the thing being described just came into existence) but
 * still correlates on the *webhook event's* id, deliberately keeping the
 * webhook's own ingestion trail (WEBHOOK_RECEIVED -> WEBHOOK_NORMALIZED ->
 * SIGNAL_ACCEPTED) together as one queryable group. `getFullTradingViewTimeline`
 * below is what stitches the two correlation groups back together for the
 * dashboard.
 */

function isUniqueConstraintViolation(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as unknown[]).includes(field)
  );
}

export interface CreateInboundWebhookEventInput {
  provider: WebhookProvider;
  schemaVersion: number;
  rawPayload: Record<string, unknown>;
  fingerprint: string;
}

export interface CreateInboundWebhookEventResult {
  event: InboundWebhookEvent;
  /** true iff an event with this fingerprint already existed (this call inserted nothing new). */
  wasDuplicate: boolean;
}

/**
 * Attempts to insert a new InboundWebhookEvent (status RECEIVED) and emit
 * WEBHOOK_RECEIVED, atomically, in one transaction. If two requests race
 * with the identical fingerprint, only one `create` can ever succeed,
 * Postgres's unique constraint on `fingerprint` guarantees it, not
 * application-level locking. The loser's `create` throws a P2002 unique
 * violation; that is caught *outside* the failed transaction (a failed
 * transaction cannot be reused for further reads/writes), the existing row
 * is looked up by fingerprint, a WEBHOOK_DUPLICATE_DETECTED event is
 * emitted correlated to that *existing* row's id, and `{ event: existing,
 * wasDuplicate: true }` is returned. Nothing extra is ever inserted into
 * InboundWebhookEvent for a duplicate delivery.
 */
export async function createInboundWebhookEvent(
  input: CreateInboundWebhookEventInput,
): Promise<CreateInboundWebhookEventResult> {
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.inboundWebhookEvent.create({
        data: {
          provider: input.provider,
          schemaVersion: input.schemaVersion,
          rawPayload: input.rawPayload as Prisma.InputJsonValue,
          fingerprint: input.fingerprint,
        },
      });

      await createJournalEvent(
        {
          eventType: "WEBHOOK_RECEIVED",
          entityType: "INBOUND_WEBHOOK_EVENT",
          entityId: created.id,
          correlationId: created.id,
        },
        tx,
      );

      return created;
    });

    return { event: mapInboundWebhookEvent(row), wasDuplicate: false };
  } catch (error) {
    if (!isUniqueConstraintViolation(error, "fingerprint")) {
      throw error;
    }

    const existing = await prisma.inboundWebhookEvent.findUnique({
      where: { fingerprint: input.fingerprint },
    });
    if (!existing) {
      // Unreachable in practice: a unique-constraint violation on
      // `fingerprint` guarantees a row with this fingerprint exists. Surface
      // the original error rather than fabricate a NotFoundError.
      throw error;
    }

    await createJournalEvent({
      eventType: "WEBHOOK_DUPLICATE_DETECTED",
      entityType: "INBOUND_WEBHOOK_EVENT",
      entityId: existing.id,
      correlationId: existing.id,
    });

    return { event: mapInboundWebhookEvent(existing), wasDuplicate: true };
  }
}

/**
 * Internal bookkeeping transition (RECEIVED -> QUEUED, synchronously in the
 * HTTP handler). No journal event: the fixed vocabulary has no dedicated
 * type for it and WEBHOOK_RECEIVED already covers "we got it".
 */
export async function markInboundWebhookEventQueued(id: string): Promise<InboundWebhookEvent> {
  const existing = await prisma.inboundWebhookEvent.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("InboundWebhookEvent", id);
  }

  const row = await prisma.inboundWebhookEvent.update({
    where: { id },
    data: { processingStatus: "QUEUED" },
  });
  return mapInboundWebhookEvent(row);
}

export async function markInboundWebhookEventProcessing(id: string): Promise<InboundWebhookEvent> {
  const existing = await prisma.inboundWebhookEvent.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("InboundWebhookEvent", id);
  }

  const row = await prisma.inboundWebhookEvent.update({
    where: { id },
    data: { processingStatus: "PROCESSING", processingStartedAt: new Date() },
  });
  return mapInboundWebhookEvent(row);
}

export interface MarkInboundWebhookEventProcessedInput {
  normalizedPayload: Record<string, unknown>;
  setupId: string;
}

export async function markInboundWebhookEventProcessed(
  id: string,
  input: MarkInboundWebhookEventProcessedInput,
): Promise<InboundWebhookEvent> {
  const existing = await prisma.inboundWebhookEvent.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("InboundWebhookEvent", id);
  }

  const row = await prisma.inboundWebhookEvent.update({
    where: { id },
    data: {
      processingStatus: "PROCESSED",
      processingCompletedAt: new Date(),
      normalizedPayload: input.normalizedPayload as Prisma.InputJsonValue,
      setupId: input.setupId,
    },
  });
  return mapInboundWebhookEvent(row);
}

export interface MarkInboundWebhookEventRejectedInput {
  failureCode: WebhookFailureCode | string;
  failureMessage: string;
}

export async function markInboundWebhookEventRejected(
  id: string,
  input: MarkInboundWebhookEventRejectedInput,
): Promise<InboundWebhookEvent> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inboundWebhookEvent.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("InboundWebhookEvent", id);
    }

    const row = await tx.inboundWebhookEvent.update({
      where: { id },
      data: {
        processingStatus: "REJECTED",
        processingCompletedAt: new Date(),
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
      },
    });

    await createJournalEvent(
      {
        eventType: "WEBHOOK_REJECTED",
        entityType: "INBOUND_WEBHOOK_EVENT",
        entityId: row.id,
        correlationId: row.id,
      },
      tx,
    );

    return mapInboundWebhookEvent(row);
  });
}

export interface MarkInboundWebhookEventUnsupportedInput {
  failureMessage: string;
}

/**
 * The fixed JournalEventType vocabulary has no separate "unsupported" event
 * type: any terminal non-success outcome (REJECTED or UNSUPPORTED) gets an
 * audit event via WEBHOOK_REJECTED. `failureCode` is always fixed to
 * UNSUPPORTED_SCHEMA_VERSION here, since that is the only reason this
 * processingStatus is ever set (see WEBHOOK_PROCESSING_STATUSES).
 */
export async function markInboundWebhookEventUnsupported(
  id: string,
  input: MarkInboundWebhookEventUnsupportedInput,
): Promise<InboundWebhookEvent> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inboundWebhookEvent.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("InboundWebhookEvent", id);
    }

    const row = await tx.inboundWebhookEvent.update({
      where: { id },
      data: {
        processingStatus: "UNSUPPORTED",
        processingCompletedAt: new Date(),
        failureCode: "UNSUPPORTED_SCHEMA_VERSION" satisfies WebhookFailureCode,
        failureMessage: input.failureMessage,
      },
    });

    await createJournalEvent(
      {
        eventType: "WEBHOOK_REJECTED",
        entityType: "INBOUND_WEBHOOK_EVENT",
        entityId: row.id,
        correlationId: row.id,
      },
      tx,
    );

    return mapInboundWebhookEvent(row);
  });
}

export interface MarkInboundWebhookEventFailedInput {
  failureMessage: string;
  failureCode?: WebhookFailureCode | string;
}

export async function markInboundWebhookEventFailed(
  id: string,
  input: MarkInboundWebhookEventFailedInput,
): Promise<InboundWebhookEvent> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inboundWebhookEvent.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("InboundWebhookEvent", id);
    }

    const row = await tx.inboundWebhookEvent.update({
      where: { id },
      data: {
        processingStatus: "FAILED",
        processingCompletedAt: new Date(),
        failureCode: input.failureCode ?? ("INTERNAL_ERROR" satisfies WebhookFailureCode),
        failureMessage: input.failureMessage,
      },
    });

    await createJournalEvent(
      {
        eventType: "WEBHOOK_PROCESSING_FAILED",
        entityType: "INBOUND_WEBHOOK_EVENT",
        entityId: row.id,
        correlationId: row.id,
      },
      tx,
    );

    return mapInboundWebhookEvent(row);
  });
}

/** Call after a successful normalization step. No row change. */
export async function emitWebhookNormalized(id: string): Promise<JournalEvent> {
  return createJournalEvent({
    eventType: "WEBHOOK_NORMALIZED",
    entityType: "INBOUND_WEBHOOK_EVENT",
    entityId: id,
    correlationId: id,
  });
}

export interface EmitSignalAcceptedParams {
  setupId: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
}

/**
 * Deliberately correlated on the *webhook event's* id, not the Setup's, see
 * the module-level comment above. No row change.
 */
export async function emitSignalAccepted(
  webhookEventId: string,
  params: EmitSignalAcceptedParams,
): Promise<JournalEvent> {
  return createJournalEvent({
    eventType: "SIGNAL_ACCEPTED",
    entityType: "SETUP",
    entityId: params.setupId,
    correlationId: webhookEventId,
    instrumentId: params.instrumentId,
    strategyId: params.strategyId,
    strategyVersionId: params.strategyVersionId,
  });
}

export async function getInboundWebhookEvent(id: string): Promise<InboundWebhookEvent | null> {
  const row = await prisma.inboundWebhookEvent.findUnique({ where: { id } });
  return row ? mapInboundWebhookEvent(row) : null;
}

export interface InboundWebhookEventFilters {
  provider?: WebhookProvider;
  processingStatus?: WebhookProcessingStatus;
  setupId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/** Newest `receivedAt` first. */
export async function listInboundWebhookEvents(
  filters: InboundWebhookEventFilters = {},
): Promise<InboundWebhookEvent[]> {
  const rows = await prisma.inboundWebhookEvent.findMany({
    where: {
      provider: filters.provider,
      processingStatus: filters.processingStatus,
      setupId: filters.setupId,
      receivedAt:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    },
    orderBy: { receivedAt: "desc" },
  });
  return rows.map(mapInboundWebhookEvent);
}

/** Mirrors getSetupTimelineRaw in journal-events.ts: this webhook event's own ingestion trail. */
export async function getInboundWebhookEventTimelineRaw(id: string): Promise<PrismaJournalEventRow[]> {
  return listJournalEventRows({ correlationId: id });
}

/** Mirrors getSetupTimeline in setups.ts: this webhook event's own ingestion trail. */
export async function getInboundWebhookEventTimeline(id: string): Promise<JournalEvent[]> {
  const rows = await getInboundWebhookEventTimelineRaw(id);
  return rows.map(mapJournalEvent);
}

/**
 * The combined reconstruction the dashboard needs: "TradingView fired ->
 * received -> normalized -> resolved -> setup created -> status changes" as
 * one timeline. Merges the webhook event's own trail (correlated on its own
 * id) with the Setup's own trail (correlated on setup.id) once one exists,
 * via `mergeJournalEventRows` (timestamp, then `sequence` to break a tie
 * deterministically — see that function's doc comment), mapping to the
 * domain type only once at the end. If no Setup was ever created (still
 * processing, or rejected before one existed), returns just the webhook
 * event's own timeline.
 */
export async function getFullTradingViewTimeline(webhookEventId: string): Promise<JournalEvent[]> {
  const event = await getInboundWebhookEvent(webhookEventId);
  const webhookRows = await getInboundWebhookEventTimelineRaw(webhookEventId);

  if (!event?.setupId) {
    return webhookRows.map(mapJournalEvent);
  }

  const setupRows = await getSetupTimelineRaw(event.setupId);
  return mergeJournalEventRows(webhookRows, setupRows).map(mapJournalEvent);
}
