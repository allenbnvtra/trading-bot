import { Decimal } from "decimal.js";
import { calculateExcursions, calculateGrossPnl, calculateNetPnl, calculateRMultiple } from "@trading-copilot/risk-engine";
import type { Direction, ExecutionMode, PostTradeOutcome, SkipReason, Timeframe } from "@trading-copilot/shared-types";
import type { JournalTrade } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { JournalTradeStateError, NotFoundError } from "../errors";
import { mapJournalTrade } from "../mappers";
import { getCandles } from "./candles";
import { createJournalEvent } from "./journal-events";

export interface CreateJournalTradeInput {
  setupId?: string | null;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  plannedEntry: Decimal;
  plannedStop: Decimal;
  plannedTarget1?: Decimal | null;
  plannedTarget2?: Decimal | null;
  plannedRisk?: Decimal | null;
  executionMode: Extract<ExecutionMode, "PAPER" | "MANUAL_LIVE" | "SKIPPED">;
  skipReason?: SkipReason | null;
  entryNotes?: string | null;
}

/**
 * SKIPPED means a READY setup was deliberately not taken — it never passes
 * through PLANNED. PAPER/MANUAL_LIVE start PLANNED and move to OPEN via
 * recordJournalTradeEntry. Either way `correlationId` is the Setup's id when
 * one exists, so this trade's events join the same timeline as its Setup's
 * (see getSetupTimeline) — falling back to the trade's own id otherwise.
 */
export async function createJournalTrade(input: CreateJournalTradeInput): Promise<JournalTrade> {
  return prisma.$transaction(async (tx) => {
    const isSkipped = input.executionMode === "SKIPPED";

    const row = await tx.journalTrade.create({
      data: {
        setupId: input.setupId ?? null,
        instrumentId: input.instrumentId,
        strategyId: input.strategyId,
        strategyVersionId: input.strategyVersionId,
        direction: input.direction,
        plannedEntry: input.plannedEntry.toString(),
        plannedStop: input.plannedStop.toString(),
        plannedTarget1: input.plannedTarget1?.toString() ?? null,
        plannedTarget2: input.plannedTarget2?.toString() ?? null,
        plannedRisk: input.plannedRisk?.toString() ?? null,
        executionMode: input.executionMode,
        status: isSkipped ? "SKIPPED" : "PLANNED",
        entryNotes: input.entryNotes ?? null,
        skipReason: input.skipReason ?? null,
      },
    });

    await createJournalEvent(
      {
        eventType: isSkipped ? "TRADE_SKIPPED" : "TRADE_READY",
        entityType: "JOURNAL_TRADE",
        entityId: row.id,
        correlationId: input.setupId ?? row.id,
        instrumentId: row.instrumentId,
        strategyId: row.strategyId,
        strategyVersionId: row.strategyVersionId,
      },
      tx,
    );

    return mapJournalTrade(row);
  });
}

export interface RecordJournalTradeEntryInput {
  actualEntry: Decimal;
  entryTimestamp: Date;
  quantity: number;
  estimatedFees?: Decimal | null;
  estimatedSlippage?: Decimal | null;
}

export async function recordJournalTradeEntry(
  id: string,
  input: RecordJournalTradeEntryInput,
): Promise<JournalTrade> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.journalTrade.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("JournalTrade", id);
    }
    if (existing.status !== "PLANNED") {
      throw new JournalTradeStateError("record entry", existing.status, "PLANNED");
    }

    const row = await tx.journalTrade.update({
      where: { id },
      data: {
        actualEntry: input.actualEntry.toString(),
        entryTimestamp: input.entryTimestamp,
        quantity: input.quantity,
        estimatedFees: input.estimatedFees?.toString() ?? null,
        estimatedSlippage: input.estimatedSlippage?.toString() ?? null,
        status: "OPEN",
      },
    });

    await createJournalEvent(
      {
        eventType: "TRADE_EXECUTED",
        entityType: "JOURNAL_TRADE",
        entityId: row.id,
        correlationId: row.setupId ?? row.id,
        instrumentId: row.instrumentId,
        strategyId: row.strategyId,
        strategyVersionId: row.strategyVersionId,
      },
      tx,
    );

    return mapJournalTrade(row);
  });
}

export interface CloseJournalTradeInput {
  actualExit: Decimal;
  exitTimestamp: Date;
  actualFees?: Decimal | null;
  actualSlippage?: Decimal | null;
  exitNotes?: string | null;
}

export interface ComputedJournalTradeClose {
  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  /** null only when there is no real risk baseline (plannedRisk was never set) — never fabricated as 0. */
  rMultiple: Decimal | null;
  outcome: PostTradeOutcome;
}

/**
 * Pure P&L computation, calling only packages/risk-engine functions —
 * extracted from closeJournalTrade so it is unit-testable without a
 * database (see src/repositories/journal-trades.test.ts).
 */
export function computeJournalTradeClose(
  direction: Direction,
  actualEntry: Decimal,
  actualExit: Decimal,
  quantity: number,
  pointValue: Decimal,
  fees: Decimal,
  plannedRisk: Decimal | null,
): ComputedJournalTradeClose {
  const grossPnl = calculateGrossPnl(actualEntry, actualExit, quantity, pointValue, direction);
  const netPnl = calculateNetPnl(grossPnl, fees);
  // A risk baseline of exactly zero is just as meaningless as no baseline at
  // all — calculateRMultiple requires a strictly-positive risk amount and
  // would otherwise throw here, which would surface as an unhandled error at
  // close time for a trade that was allowed to record plannedRisk: "0" at
  // creation (createJournalTradeSchema permits zero, since "0" and "unset"
  // are indistinguishable to a caller who genuinely doesn't know the risk
  // yet). Treat both the same: rMultiple is null, never fabricated as 0.
  const hasRiskBaseline = plannedRisk !== null && plannedRisk.greaterThan(0);
  const rMultiple = hasRiskBaseline ? calculateRMultiple(netPnl, plannedRisk) : null;
  const outcome: PostTradeOutcome = netPnl.isZero() ? "BREAKEVEN" : netPnl.isPositive() ? "WIN" : "LOSS";
  return { grossPnl, fees, netPnl, rMultiple, outcome };
}

export async function closeJournalTrade(id: string, input: CloseJournalTradeInput): Promise<JournalTrade> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.journalTrade.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError("JournalTrade", id);
    }
    if (existing.status !== "OPEN") {
      throw new JournalTradeStateError("close", existing.status, "OPEN");
    }

    const instrument = await tx.instrument.findUnique({ where: { id: existing.instrumentId } });
    if (!instrument) {
      throw new NotFoundError("Instrument", existing.instrumentId);
    }

    // Guaranteed non-null for an OPEN trade (set by recordJournalTradeEntry),
    // but asserted defensively rather than silently producing a broken row.
    if (existing.actualEntry === null || existing.quantity === null || existing.entryTimestamp === null) {
      throw new Error(
        `JournalTrade ${id} is OPEN but missing actualEntry/quantity/entryTimestamp — data integrity violation`,
      );
    }

    const actualEntry = new Decimal(existing.actualEntry.toString());
    const quantity = existing.quantity;
    const pointValue = new Decimal(instrument.pointValue.toString());
    const plannedRisk = existing.plannedRisk === null ? null : new Decimal(existing.plannedRisk.toString());
    const estimatedFees = existing.estimatedFees === null ? null : new Decimal(existing.estimatedFees.toString());
    const fees = input.actualFees ?? estimatedFees ?? new Decimal(0);

    const { grossPnl, netPnl, rMultiple, outcome } = computeJournalTradeClose(
      existing.direction,
      actualEntry,
      input.actualExit,
      quantity,
      pointValue,
      fees,
      plannedRisk,
    );

    // MFE/MAE, server-computed over real candles between entry and exit —
    // never client-supplied (see docs/notifications.md and CLAUDE.md
    // "financial calculations are never independently produced in a
    // controller"). Only possible when this trade has a Setup lineage (a
    // timeframe to know which candle series to query) — a manually-logged
    // trade with setupId: null legitimately has none, and "unknown stays
    // unknown" (mfe/mae null) rather than a fabricated value or a thrown
    // error blocking the close.
    let mfe: Decimal | null = null;
    let mae: Decimal | null = null;
    if (existing.setupId !== null) {
      const setup = await tx.setup.findUnique({
        where: { id: existing.setupId },
        include: { marketSnapshot: true },
      });
      if (setup) {
        const candles = await getCandles(
          existing.instrumentId,
          setup.marketSnapshot.timeframe as Timeframe,
          existing.entryTimestamp,
          input.exitTimestamp,
        );
        if (candles.length > 0) {
          const excursions = calculateExcursions(
            candles.map((c) => ({ high: c.high, low: c.low })),
            actualEntry,
            existing.direction,
          );
          mfe = excursions.mfe;
          mae = excursions.mae;
        }
      }
    }

    const row = await tx.journalTrade.update({
      where: { id },
      data: {
        actualExit: input.actualExit.toString(),
        exitTimestamp: input.exitTimestamp,
        actualFees: fees.toString(),
        actualSlippage: input.actualSlippage?.toString() ?? null,
        mfe: mfe?.toString() ?? null,
        mae: mae?.toString() ?? null,
        exitNotes: input.exitNotes ?? null,
        grossPnl: grossPnl.toString(),
        netPnl: netPnl.toString(),
        rMultiple: rMultiple?.toString() ?? null,
        outcome,
        status: "CLOSED",
      },
    });

    await createJournalEvent(
      {
        eventType: "TRADE_CLOSED",
        entityType: "JOURNAL_TRADE",
        entityId: row.id,
        correlationId: row.setupId ?? row.id,
        instrumentId: row.instrumentId,
        strategyId: row.strategyId,
        strategyVersionId: row.strategyVersionId,
      },
      tx,
    );

    return mapJournalTrade(row);
  });
}

export async function getJournalTrade(id: string): Promise<JournalTrade | null> {
  const row = await prisma.journalTrade.findUnique({ where: { id } });
  return row ? mapJournalTrade(row) : null;
}

export interface JournalTradeFilters {
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  direction?: Direction;
  executionMode?: ExecutionMode;
  dateFrom?: Date;
  dateTo?: Date;
}

export async function listJournalTrades(filters: JournalTradeFilters = {}): Promise<JournalTrade[]> {
  const rows = await prisma.journalTrade.findMany({
    where: {
      instrumentId: filters.instrumentId,
      strategyId: filters.strategyId,
      strategyVersionId: filters.strategyVersionId,
      direction: filters.direction,
      executionMode: filters.executionMode,
      createdAt:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapJournalTrade);
}

export interface CreateAndRecordJournalTradeEntryInput {
  setupId: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  plannedEntry: Decimal;
  plannedStop: Decimal;
  plannedTarget1: Decimal | null;
  plannedTarget2: Decimal | null;
  plannedRisk: Decimal | null;
  executionMode: Extract<ExecutionMode, "PAPER" | "MANUAL_LIVE">;
  actualEntry: Decimal;
  quantity: number;
  entryTimestamp: Date;
  actualFees: Decimal | null;
  actualSlippage: Decimal | null;
  notes: string | null;
}

/**
 * Atomically creates a JournalTrade (PLANNED) and immediately records its
 * entry (-> OPEN) in one transaction, for the dashboard's single-action
 * "I ENTERED THIS TRADE"/"PAPER TRADE" buttons — the human is recording one
 * real-world event (a fill that already happened), not two separate
 * journal actions, so the API surface should not force a two-step dance
 * that could be left half-done by a crash between steps.
 */
export async function createAndRecordJournalTradeEntry(
  input: CreateAndRecordJournalTradeEntryInput,
): Promise<JournalTrade> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.journalTrade.create({
      data: {
        setupId: input.setupId,
        instrumentId: input.instrumentId,
        strategyId: input.strategyId,
        strategyVersionId: input.strategyVersionId,
        direction: input.direction,
        plannedEntry: input.plannedEntry.toString(),
        plannedStop: input.plannedStop.toString(),
        plannedTarget1: input.plannedTarget1?.toString() ?? null,
        plannedTarget2: input.plannedTarget2?.toString() ?? null,
        plannedRisk: input.plannedRisk?.toString() ?? null,
        executionMode: input.executionMode,
        status: "OPEN",
        actualEntry: input.actualEntry.toString(),
        entryTimestamp: input.entryTimestamp,
        quantity: input.quantity,
        estimatedFees: input.actualFees?.toString() ?? null,
        estimatedSlippage: input.actualSlippage?.toString() ?? null,
        entryNotes: input.notes ?? null,
      },
    });

    await createJournalEvent(
      {
        eventType: "TRADE_READY",
        entityType: "JOURNAL_TRADE",
        entityId: created.id,
        correlationId: input.setupId,
        instrumentId: created.instrumentId,
        strategyId: created.strategyId,
        strategyVersionId: created.strategyVersionId,
      },
      tx,
    );
    await createJournalEvent(
      {
        eventType: "TRADE_EXECUTED",
        entityType: "JOURNAL_TRADE",
        entityId: created.id,
        correlationId: input.setupId,
        instrumentId: created.instrumentId,
        strategyId: created.strategyId,
        strategyVersionId: created.strategyVersionId,
      },
      tx,
    );

    return mapJournalTrade(created);
  });
}
