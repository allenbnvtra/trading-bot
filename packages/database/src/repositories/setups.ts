import type { Prisma } from "@prisma/client";
import type { Decimal } from "decimal.js";
import {
  TERMINAL_SETUP_STATUSES,
  type Direction,
  type JournalEventType,
  type SetupSource,
  type SetupStatus,
} from "@trading-copilot/shared-types";
import type { Setup } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { NotFoundError, SetupTransitionError } from "../errors";
import { mapSetup } from "../mappers";
import { createJournalEvent } from "./journal-events";

/**
 * A Setup's mutable surface is only its state-machine fields
 * (status/decisionSummary/updatedAt/expiresAt) — see
 * .claude/agents/data-engineer.md. Every other field is set once at
 * creation and never changed; there is deliberately no general-purpose
 * `updateSetup` function.
 */

export interface CreateSetupInput {
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  marketSnapshotId: string;
  direction: Direction;
  source: SetupSource;
  plannedEntry: Decimal;
  plannedStop: Decimal;
  plannedTarget1: Decimal;
  plannedTarget2?: Decimal | null;
  decisionSummary?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}

/**
 * Creates the Setup and emits its lifecycle event(s) atomically: always
 * SETUP_CREATED, plus STRATEGY_EVALUATED when source is BACKTEST (this Setup
 * originated from a strategy evaluation against historical/live data).
 */
export async function createSetup(input: CreateSetupInput): Promise<Setup> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.setup.create({
      data: {
        instrumentId: input.instrumentId,
        strategyId: input.strategyId,
        strategyVersionId: input.strategyVersionId,
        marketSnapshotId: input.marketSnapshotId,
        direction: input.direction,
        source: input.source,
        plannedEntry: input.plannedEntry.toString(),
        plannedStop: input.plannedStop.toString(),
        plannedTarget1: input.plannedTarget1.toString(),
        plannedTarget2: input.plannedTarget2?.toString() ?? null,
        decisionSummary: input.decisionSummary ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        expiresAt: input.expiresAt ?? null,
      },
    });

    const eventRefs = {
      entityType: "SETUP" as const,
      entityId: row.id,
      correlationId: row.id,
      instrumentId: row.instrumentId,
      strategyId: row.strategyId,
      strategyVersionId: row.strategyVersionId,
    };

    await createJournalEvent({ ...eventRefs, eventType: "SETUP_CREATED" }, tx);

    if (input.source === "BACKTEST") {
      await createJournalEvent({ ...eventRefs, eventType: "STRATEGY_EVALUATED" }, tx);
    }

    return mapSetup(row);
  });
}

export async function getSetup(id: string): Promise<Setup | null> {
  const row = await prisma.setup.findUnique({ where: { id } });
  return row ? mapSetup(row) : null;
}

export interface SetupFilters {
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  status?: SetupStatus;
  source?: SetupSource;
  direction?: Direction;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listSetups(filters: SetupFilters = {}): Promise<Setup[]> {
  const rows = await prisma.setup.findMany({
    where: {
      instrumentId: filters.instrumentId,
      strategyId: filters.strategyId,
      strategyVersionId: filters.strategyVersionId,
      status: filters.status,
      source: filters.source,
      direction: filters.direction,
      createdAt:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapSetup);
}

/**
 * The exact Setup status transition matrix (see docs/trade-journal-design.md
 * and SETUP_STATUSES / TERMINAL_SETUP_STATUSES in shared-types). No
 * backward transitions, no same-status no-op, no transition out of a
 * terminal status — anything not listed here throws SetupTransitionError.
 */
const ALLOWED_TRANSITIONS: Record<SetupStatus, readonly SetupStatus[]> = {
  WATCH: ["PREPARE", "READY", "REJECTED", "INVALIDATED", "EXPIRED"],
  PREPARE: ["READY", "REJECTED", "INVALIDATED", "EXPIRED"],
  READY: ["REJECTED", "INVALIDATED", "EXPIRED"],
  REJECTED: [],
  INVALIDATED: [],
  EXPIRED: [],
};

/**
 * The Milestone 2 JournalEventType vocabulary has no event for a transition
 * into PREPARE (see docs/trade-journal-design.md's fixed event list) — a
 * deliberate, known limitation. Every other successful transition emits
 * exactly one event keyed off the *new* status.
 */
const TRANSITION_EVENT_TYPES: Partial<Record<SetupStatus, JournalEventType>> = {
  READY: "SETUP_APPROVED",
  REJECTED: "SETUP_REJECTED",
  INVALIDATED: "SETUP_INVALIDATED",
  EXPIRED: "SETUP_EXPIRED",
};

/**
 * Pure predicate over the state-machine matrix above — exported so the full
 * transition table can be unit-tested (every valid transition, every
 * invalid one, every terminal state) without a database. `transitionSetupStatus`
 * below is the only place that actually mutates a Setup's status; this
 * function only answers "would that be allowed."
 */
export function isAllowedSetupTransition(from: SetupStatus, to: SetupStatus): boolean {
  if (TERMINAL_SETUP_STATUSES.includes(from)) {
    return false;
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionSetupStatusInput {
  status: SetupStatus;
  decisionSummary?: string | null;
}

export async function transitionSetupStatus(
  id: string,
  input: TransitionSetupStatusInput,
): Promise<Setup> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.setup.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("Setup", id);
    }

    if (!isAllowedSetupTransition(existing.status as SetupStatus, input.status)) {
      throw new SetupTransitionError(existing.status, input.status);
    }

    const row = await tx.setup.update({
      where: { id },
      data: {
        status: input.status,
        decisionSummary: input.decisionSummary ?? existing.decisionSummary,
      },
    });

    const eventType = TRANSITION_EVENT_TYPES[input.status];
    if (eventType) {
      await createJournalEvent(
        {
          eventType,
          entityType: "SETUP",
          entityId: row.id,
          correlationId: row.id,
          instrumentId: row.instrumentId,
          strategyId: row.strategyId,
          strategyVersionId: row.strategyVersionId,
        },
        tx,
      );
    }

    return mapSetup(row);
  });
}
