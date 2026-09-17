import { Decimal } from "decimal.js";
import type { Prisma } from "@prisma/client";
import type { Direction, ExecutionMode } from "@trading-copilot/shared-types";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { prisma } from "./client";

/**
 * Backtest -> journal analytics adapter (see docs/trade-journal-design.md
 * "Backtest -> journal compatibility" and CLAUDE.md). Connects Milestone 1's
 * BacktestTrade rows and Milestone 2's JournalTrade rows to a single
 * normalized shape for packages/analytics, without physically duplicating
 * either table: a merge of two queries in memory, not a database-level
 * union (Prisma has no cross-model union) and not a copy of rows into a
 * third table.
 *
 * Only ever produces rows for *closed, realized* trades: every BacktestTrade
 * (always closed by construction) and every JournalTrade with
 * status === "CLOSED" — PLANNED/OPEN/SKIPPED JournalTrade rows have no
 * realized P&L and are never included.
 */

export interface NormalizedTradeFilters {
  strategyId?: string;
  strategyVersionId?: string;
  instrumentId?: string;
  direction?: Direction;
  executionMode?: ExecutionMode;
  dateFrom?: Date;
  dateTo?: Date;
}

function entryTimestampRange(
  filters: NormalizedTradeFilters,
): Prisma.DateTimeFilter | undefined {
  if (!filters.dateFrom && !filters.dateTo) return undefined;
  return { gte: filters.dateFrom, lte: filters.dateTo };
}

async function getNormalizedBacktestTrades(
  filters: NormalizedTradeFilters,
): Promise<NormalizedTrade[]> {
  // BacktestTrade rows only ever have executionMode "BACKTEST" in the
  // normalized view — if the caller filtered for a different execution
  // mode, no BacktestTrade row can match.
  if (filters.executionMode && filters.executionMode !== "BACKTEST") {
    return [];
  }

  const rows = await prisma.backtestTrade.findMany({
    where: {
      instrumentId: filters.instrumentId,
      strategyVersionId: filters.strategyVersionId,
      direction: filters.direction,
      strategyVersion: filters.strategyId ? { strategyId: filters.strategyId } : undefined,
      entryTimestamp: entryTimestampRange(filters),
    },
    include: { strategyVersion: { select: { strategyId: true } } },
    orderBy: { entryTimestamp: "asc" },
  });

  return rows.map((row): NormalizedTrade => ({
    source: "BACKTEST",
    id: row.id,
    strategyId: row.strategyVersion.strategyId,
    strategyVersionId: row.strategyVersionId,
    instrumentId: row.instrumentId,
    direction: row.direction,
    executionMode: "BACKTEST",
    entryTimestamp: row.entryTimestamp,
    exitTimestamp: row.exitTimestamp,
    entryPrice: new Decimal(row.entryPrice.toString()),
    exitPrice: new Decimal(row.exitPrice.toString()),
    quantity: row.quantity,
    grossPnl: new Decimal(row.grossPnl.toString()),
    fees: new Decimal(row.fees.toString()),
    netPnl: new Decimal(row.netPnl.toString()),
    riskAmount: new Decimal(row.riskAmount.toString()),
    rMultiple: new Decimal(row.rMultiple.toString()),
    mfe: new Decimal(row.maximumFavorableExcursion.toString()),
    mae: new Decimal(row.maximumAdverseExcursion.toString()),
    // packages/backtester bakes slippage into fill prices — nothing separate to report.
    slippage: null,
  }));
}

async function getNormalizedJournalTrades(
  filters: NormalizedTradeFilters,
): Promise<NormalizedTrade[]> {
  // "BACKTEST" is never a real JournalTrade.executionMode value (see
  // shared-types EXECUTION_MODES doc comment) — if the caller filtered for
  // it, no JournalTrade row can match.
  if (filters.executionMode === "BACKTEST") {
    return [];
  }

  const rows = await prisma.journalTrade.findMany({
    where: {
      status: "CLOSED",
      instrumentId: filters.instrumentId,
      strategyId: filters.strategyId,
      strategyVersionId: filters.strategyVersionId,
      direction: filters.direction,
      executionMode: filters.executionMode,
      entryTimestamp: entryTimestampRange(filters),
    },
    orderBy: { entryTimestamp: "asc" },
  });

  return rows.map((row): NormalizedTrade => {
    if (
      row.actualEntry === null ||
      row.actualExit === null ||
      row.quantity === null ||
      row.entryTimestamp === null ||
      row.exitTimestamp === null ||
      row.grossPnl === null ||
      row.netPnl === null
    ) {
      // Guaranteed non-null for a CLOSED trade by closeJournalTrade — this
      // is a data-integrity violation, not a normal "missing field" case.
      throw new Error(
        `JournalTrade ${row.id} has status CLOSED but is missing required fields — data integrity violation`,
      );
    }

    return {
      source: "JOURNAL",
      id: row.id,
      strategyId: row.strategyId,
      strategyVersionId: row.strategyVersionId,
      instrumentId: row.instrumentId,
      direction: row.direction,
      executionMode: row.executionMode,
      entryTimestamp: row.entryTimestamp,
      exitTimestamp: row.exitTimestamp,
      entryPrice: new Decimal(row.actualEntry.toString()),
      exitPrice: new Decimal(row.actualExit.toString()),
      quantity: row.quantity,
      grossPnl: new Decimal(row.grossPnl.toString()),
      fees: new Decimal((row.actualFees ?? "0").toString()),
      netPnl: new Decimal(row.netPnl.toString()),
      riskAmount: row.plannedRisk === null ? null : new Decimal(row.plannedRisk.toString()),
      rMultiple: row.rMultiple === null ? null : new Decimal(row.rMultiple.toString()),
      mfe: row.mfe === null ? null : new Decimal(row.mfe.toString()),
      mae: row.mae === null ? null : new Decimal(row.mae.toString()),
      slippage:
        row.actualSlippage !== null
          ? new Decimal(row.actualSlippage.toString())
          : row.estimatedSlippage !== null
            ? new Decimal(row.estimatedSlippage.toString())
            : null,
    };
  });
}

/**
 * Both source lists are individually ordered by entryTimestamp ascending,
 * but concatenating two independently-sorted lists does not itself produce
 * a globally sorted list — packages/analytics' metrics/grouping functions
 * treat their input as already chronological (for drawdown and win/loss
 * streaks) and never re-sort, so callers must hand back one real
 * time-ordered merge, not "backtest trades, then journal trades." Exported
 * (pure, no I/O) so this is unit-testable without a database — see
 * analytics-adapter.test.ts.
 */
export function mergeNormalizedTradesChronologically(
  backtestTrades: NormalizedTrade[],
  journalTrades: NormalizedTrade[],
): NormalizedTrade[] {
  return [...backtestTrades, ...journalTrades].sort(
    (a, b) => a.entryTimestamp.getTime() - b.entryTimestamp.getTime(),
  );
}

export async function getNormalizedTrades(
  filters: NormalizedTradeFilters = {},
): Promise<NormalizedTrade[]> {
  const [backtestTrades, journalTrades] = await Promise.all([
    getNormalizedBacktestTrades(filters),
    getNormalizedJournalTrades(filters),
  ]);
  return mergeNormalizedTradesChronologically(backtestTrades, journalTrades);
}
