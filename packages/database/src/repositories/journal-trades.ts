import { Decimal } from "decimal.js";
import { Prisma } from "@prisma/client";
import { calculateExcursions, calculateGrossPnl, calculateNetPnl, calculateRMultiple } from "@trading-copilot/risk-engine";
import type { Direction, ExecutionMode, PostTradeOutcome, SkipReason, Timeframe } from "@trading-copilot/shared-types";
import type { JournalTrade } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { JournalTradeActiveDecisionConflictError, JournalTradeStateError, NotFoundError } from "../errors";
import { mapJournalTrade } from "../mappers";
import { getCandles } from "./candles";
import { createJournalEvent } from "./journal-events";

/**
 * Mirrors inbound-webhook-events.ts's and trade-screenshots.ts's
 * isUniqueConstraintViolation exactly: a type-safe P2002 check that also
 * verifies the violated constraint is genuinely the one this call cares
 * about (`error.meta.target` includes every field in `fields`), rather than
 * treating any P2002 on the table as a match. `JournalTrade` has exactly one
 * unique index on `setupId` — the partial `JournalTrade_setupId_active_
 * decision_key` index added for "at most one active/recorded decision per
 * Setup" — so `["setupId"]` unambiguously identifies it. Confirmed live
 * against Postgres: even though this index has no matching `@@unique` in
 * schema.prisma (Prisma has no schema syntax for a partial index), Prisma
 * still reports `meta.target: ["setupId"]` for it, the same shape as an
 * ordinary `@@unique(["setupId"])` violation would produce.
 */
function isUniqueConstraintViolation(error: unknown, fields: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    fields.every((field) => (error.meta!.target as unknown[]).includes(field))
  );
}

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
  try {
    return await prisma.$transaction(async (tx) => {
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
          metadata: isSkipped ? { skipReason: input.skipReason ?? null } : undefined,
        },
        tx,
      );

      return mapJournalTrade(row);
    });
  } catch (error) {
    // A genuine concurrent race behind SetupService.execute()/skip()'s
    // app-level findJournalTradeBySetupId check-then-act guard — see
    // JournalTradeActiveDecisionConflictError's doc comment. Only relevant
    // when this trade targets a Setup at all (input.setupId set); a
    // manually-logged trade with no Setup lineage can never hit this index
    // (Postgres treats NULL as distinct across rows in a unique index).
    if (input.setupId && isUniqueConstraintViolation(error, ["setupId"])) {
      throw new JournalTradeActiveDecisionConflictError(input.setupId);
    }
    throw error;
  }
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
        metadata: { actualEntry: input.actualEntry.toString(), quantity: input.quantity },
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
        // A candle's `timestamp` is its OPEN time, and a real-world fill
        // happens sometime DURING a candle's interval, not exactly at its
        // open — `existing.entryTimestamp` (from a free-typed datetime-local
        // dashboard input, essentially never aligned to a candle boundary)
        // is almost always strictly inside the entry candle's interval, not
        // equal to its timestamp. Querying candles with `gte:
        // entryTimestamp` directly would therefore silently exclude the
        // entry candle itself, understating mfe/mae for a multi-candle trade
        // and producing a spurious null (masquerading as "no candle data
        // available", the case the comment above legitimately covers) for a
        // fast trade whose entry and exit both fall inside one candle.
        // Resolve the range start to that containing candle's own timestamp
        // instead. No equivalent fix is needed for the end boundary: a
        // candle's open is always <= an exit that occurred inside it, and a
        // later not-yet-happened candle is already correctly excluded by
        // `lte: exitTimestamp`.
        const entryCandle = await tx.candle.findFirst({
          where: {
            instrumentId: existing.instrumentId,
            timeframe: setup.marketSnapshot.timeframe,
            timestamp: { lte: existing.entryTimestamp },
          },
          orderBy: { timestamp: "desc" },
        });
        const rangeStart = entryCandle?.timestamp ?? existing.entryTimestamp;

        const candles = await getCandles(
          existing.instrumentId,
          setup.marketSnapshot.timeframe as Timeframe,
          rangeStart,
          input.exitTimestamp,
          tx,
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

    // Guarded with an atomic conditional `updateMany` rather than the
    // read-then-check-then-`update` this used to do. Under Postgres READ
    // COMMITTED (no `SELECT ... FOR UPDATE`), the `existing.status !==
    // "OPEN"` check above is a stale snapshot read at the START of this
    // transaction — it does not stop two genuinely concurrent
    // closeJournalTrade calls (e.g. two browser tabs) from both passing that
    // check and both reaching this point believing the trade is still OPEN.
    // A plain `update({ where: { id } })` would let the second call silently
    // overwrite the first's already-committed close data (MFE/MAE, P&L,
    // outcome) with no error to either caller. `updateMany`'s `where`
    // accepts an arbitrary filter and Postgres re-evaluates it against the
    // row's currently-committed state at execution time, not the stale
    // snapshot read above — so only one of two concurrent closes can ever
    // match and affect a row. Mirrors markScreenshotReady in
    // trade-screenshots.ts and markNotificationSent in
    // notification-deliveries.ts exactly.
    const result = await tx.journalTrade.updateMany({
      where: { id, status: "OPEN" },
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
    if (result.count === 0) {
      // Someone else concurrently closed this trade between our read above
      // and this updateMany. Re-fetch the current row to report an accurate
      // status in the thrown error, rather than guess from the stale
      // pre-update read.
      const current = await tx.journalTrade.findUnique({ where: { id } });
      throw new JournalTradeStateError("close", current?.status ?? "UNKNOWN", "OPEN");
    }

    const row = await tx.journalTrade.findUniqueOrThrow({ where: { id } });

    await createJournalEvent(
      {
        eventType: "TRADE_CLOSED",
        entityType: "JOURNAL_TRADE",
        entityId: row.id,
        correlationId: row.setupId ?? row.id,
        instrumentId: row.instrumentId,
        strategyId: row.strategyId,
        strategyVersionId: row.strategyVersionId,
        metadata: { outcome, netPnl: netPnl.toString(), rMultiple: rMultiple?.toString() ?? null },
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

/**
 * Used by SetupService.execute() and SetupService.skip() to reject a
 * double-submit or a contradictory decision (double-click, a retried HTTP
 * request, or execute()/skip() called against the same Setup in either
 * order) against the same Setup: JournalTrade.setupId has no
 * unique/one-per-setup constraint in the schema, and a Setup's own status
 * never transitions away from READY on execute or skip (see execute()'s and
 * skip()'s doc comments), so without this check a Setup could end up with
 * two independent JournalTrade rows recording contradictory decisions (e.g.
 * both a SKIPPED and an OPEN trade for the same setup). Deliberately matches
 * ANY JournalTrade status here, not just OPEN — one recorded decision
 * (executed or skipped) is final for a Setup, regardless of that trade's own
 * later lifecycle (OPEN/CLOSED/SKIPPED).
 */
export async function findJournalTradeBySetupId(setupId: string): Promise<JournalTrade | null> {
  const row = await prisma.journalTrade.findFirst({
    where: { setupId },
  });
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
  try {
    return await prisma.$transaction(async (tx) => {
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
          metadata: { actualEntry: input.actualEntry.toString(), quantity: input.quantity },
        },
        tx,
      );

      return mapJournalTrade(created);
    });
  } catch (error) {
    // See createJournalTrade's identical catch above and
    // JournalTradeActiveDecisionConflictError's doc comment — the same
    // database-level backstop, for the execute() path's
    // create-and-record-in-one-transaction variant. `input.setupId` is
    // required (not optional) on this input type, unlike CreateJournalTradeInput.
    if (isUniqueConstraintViolation(error, ["setupId"])) {
      throw new JournalTradeActiveDecisionConflictError(input.setupId);
    }
    throw error;
  }
}
