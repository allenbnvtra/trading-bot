import type { Prisma } from "@prisma/client";
import type { Decimal } from "decimal.js";
import type { Direction, Timeframe, TradeExitReason } from "@trading-copilot/shared-types";
import type {
  Backtest,
  BacktestAssumptions,
  BacktestMetrics,
  BacktestTrade,
} from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { backtestAssumptionsToJson, mapBacktest, mapBacktestMetrics, mapBacktestTrade } from "../mappers";

export interface CreateBacktestInput {
  strategyVersionId: string;
  instrumentId: string;
  timeframe: Timeframe;
  startDate: Date;
  endDate: Date;
  assumptions: BacktestAssumptions;
}

export async function createBacktest(input: CreateBacktestInput): Promise<Backtest> {
  const row = await prisma.backtest.create({
    data: {
      strategyVersionId: input.strategyVersionId,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      startDate: input.startDate,
      endDate: input.endDate,
      status: "QUEUED",
      assumptions: backtestAssumptionsToJson(input.assumptions) as Prisma.InputJsonValue,
    },
  });
  return mapBacktest(row);
}

export async function markBacktestRunning(id: string): Promise<Backtest> {
  const row = await prisma.backtest.update({
    where: { id },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return mapBacktest(row);
}

export async function markBacktestCompleted(id: string): Promise<Backtest> {
  const row = await prisma.backtest.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return mapBacktest(row);
}

export async function markBacktestFailed(id: string, errorMessage: string): Promise<Backtest> {
  const row = await prisma.backtest.update({
    where: { id },
    data: { status: "FAILED", completedAt: new Date(), errorMessage },
  });
  return mapBacktest(row);
}

export async function getBacktest(id: string): Promise<Backtest | null> {
  const row = await prisma.backtest.findUnique({ where: { id } });
  return row ? mapBacktest(row) : null;
}

export async function listBacktests(): Promise<Backtest[]> {
  const rows = await prisma.backtest.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(mapBacktest);
}

export interface NewBacktestTrade {
  strategyVersionId: string;
  instrumentId: string;
  direction: Direction;
  signalTimestamp: Date;
  entryTimestamp: Date;
  entryPrice: Decimal;
  stopPrice: Decimal;
  targetPrice: Decimal;
  exitTimestamp: Date;
  exitPrice: Decimal;
  entryReason: string;
  exitReason: TradeExitReason;
  quantity: number;
  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  riskAmount: Decimal;
  rMultiple: Decimal;
  maximumFavorableExcursion: Decimal;
  maximumAdverseExcursion: Decimal;
}

/**
 * Replaces all trades for a backtest inside a single transaction
 * (delete-existing + insert-new), so a retried BullMQ job for the same
 * backtestId never produces duplicate trade rows. Safe to call more than
 * once for the same backtest.
 */
export async function replaceBacktestTrades(
  backtestId: string,
  trades: NewBacktestTrade[],
): Promise<BacktestTrade[]> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.backtestTrade.deleteMany({ where: { backtestId } });

    if (trades.length > 0) {
      await tx.backtestTrade.createMany({
        data: trades.map((trade) => ({
          backtestId,
          strategyVersionId: trade.strategyVersionId,
          instrumentId: trade.instrumentId,
          direction: trade.direction,
          signalTimestamp: trade.signalTimestamp,
          entryTimestamp: trade.entryTimestamp,
          entryPrice: trade.entryPrice.toString(),
          stopPrice: trade.stopPrice.toString(),
          targetPrice: trade.targetPrice.toString(),
          exitTimestamp: trade.exitTimestamp,
          exitPrice: trade.exitPrice.toString(),
          entryReason: trade.entryReason,
          exitReason: trade.exitReason,
          quantity: trade.quantity,
          grossPnl: trade.grossPnl.toString(),
          fees: trade.fees.toString(),
          netPnl: trade.netPnl.toString(),
          riskAmount: trade.riskAmount.toString(),
          rMultiple: trade.rMultiple.toString(),
          maximumFavorableExcursion: trade.maximumFavorableExcursion.toString(),
          maximumAdverseExcursion: trade.maximumAdverseExcursion.toString(),
        })),
      });
    }

    return tx.backtestTrade.findMany({ where: { backtestId }, orderBy: { entryTimestamp: "asc" } });
  });

  return rows.map(mapBacktestTrade);
}

export type NewBacktestMetrics = Omit<BacktestMetrics, "id" | "backtestId">;

export async function upsertBacktestMetrics(
  backtestId: string,
  metrics: NewBacktestMetrics,
): Promise<BacktestMetrics> {
  const data = {
    totalTrades: metrics.totalTrades,
    winningTrades: metrics.winningTrades,
    losingTrades: metrics.losingTrades,
    winRate: metrics.winRate.toString(),
    grossProfit: metrics.grossProfit.toString(),
    grossLoss: metrics.grossLoss.toString(),
    netProfit: metrics.netProfit.toString(),
    profitFactor: metrics.profitFactor ? metrics.profitFactor.toString() : null,
    averageTrade: metrics.averageTrade.toString(),
    averageR: metrics.averageR.toString(),
    largestWin: metrics.largestWin.toString(),
    largestLoss: metrics.largestLoss.toString(),
    averageWin: metrics.averageWin.toString(),
    averageLoss: metrics.averageLoss.toString(),
    maxDrawdown: metrics.maxDrawdown.toString(),
    maxDrawdownPercent: metrics.maxDrawdownPercent.toString(),
    expectancy: metrics.expectancy.toString(),
    maximumConsecutiveWins: metrics.maximumConsecutiveWins,
    maximumConsecutiveLosses: metrics.maximumConsecutiveLosses,
  };

  const row = await prisma.backtestMetrics.upsert({
    where: { backtestId },
    create: { backtestId, ...data },
    update: data,
  });
  return mapBacktestMetrics(row);
}
