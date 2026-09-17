import type { Prisma } from "@prisma/client";
import type {
  JournalEntityType,
  JournalEventType,
} from "@trading-copilot/shared-types";
import type { JournalEvent } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapJournalEvent } from "../mappers";

/**
 * Append-only. This module never exposes an update or delete function — see
 * the model-level comment on JournalEvent in prisma/schema.prisma.
 */

/**
 * Any Prisma client-shaped object that supports `.journalEvent.create` — the
 * top-level `prisma` singleton or a `$transaction` callback's `tx` argument.
 * Every repository function in this module accepts one so an event can be
 * written inside the same transaction as the state change it accompanies.
 */
export type PrismaClientOrTx = Pick<Prisma.TransactionClient, "journalEvent">;

export interface CreateJournalEventInput {
  eventType: JournalEventType;
  entityType: JournalEntityType;
  entityId: string;
  correlationId?: string | null;
  instrumentId?: string | null;
  strategyId?: string | null;
  strategyVersionId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createJournalEvent(
  input: CreateJournalEventInput,
  client: PrismaClientOrTx = prisma,
): Promise<JournalEvent> {
  const row = await client.journalEvent.create({
    data: {
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: input.correlationId ?? null,
      instrumentId: input.instrumentId ?? null,
      strategyId: input.strategyId ?? null,
      strategyVersionId: input.strategyVersionId ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
  return mapJournalEvent(row);
}

export interface JournalEventFilters {
  entityType?: JournalEntityType;
  entityId?: string;
  correlationId?: string;
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

function toWhere(filters: JournalEventFilters): Prisma.JournalEventWhereInput {
  return {
    entityType: filters.entityType,
    entityId: filters.entityId,
    correlationId: filters.correlationId,
    instrumentId: filters.instrumentId,
    strategyId: filters.strategyId,
    strategyVersionId: filters.strategyVersionId,
    timestamp:
      filters.dateFrom || filters.dateTo
        ? {
            gte: filters.dateFrom,
            lte: filters.dateTo,
          }
        : undefined,
  };
}

/** Chronological (ascending) — the natural order for reconstructing a decision timeline. */
export async function listJournalEvents(filters: JournalEventFilters = {}): Promise<JournalEvent[]> {
  const rows = await prisma.journalEvent.findMany({
    where: toWhere(filters),
    orderBy: { timestamp: "asc" },
  });
  return rows.map(mapJournalEvent);
}

/**
 * Every event in a setup's lifecycle — including the events emitted by a
 * JournalTrade created from it — shares `correlationId = setupId` by
 * convention (see createSetup / createJournalTrade / recordJournalTradeEntry
 * / closeJournalTrade below), so this is a single indexed query rather than
 * a multi-table join across Setup/RiskCalculation/JournalTrade.
 */
export async function getSetupTimeline(setupId: string): Promise<JournalEvent[]> {
  return listJournalEvents({ correlationId: setupId });
}
