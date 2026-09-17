import Decimal from "decimal.js";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { averageNonNull, computeProfitFactor, isLoser, isWinner } from "./utils";

/**
 * Sign convention (matching packages/backtester/src/metrics.ts exactly):
 * grossLoss, averageLoser, and largestLoser are all reported as NEGATIVE
 * Decimals (or zero) — the sum/magnitude of losing trades' netPnl, which is
 * itself <= 0 by the isLoser convention below. netPnl (the aggregate field)
 * = grossProfit + grossLoss under this convention. profitFactor uses
 * grossLoss.abs() as its denominator.
 *
 * A "winner" is netPnl > 0; a "loser" is netPnl <= 0 (a breakeven trade
 * counts as a loser) — see utils.ts. This matches packages/backtester's
 * convention exactly, per the quant-engineer task spec.
 *
 * `trades` is treated as already being in the caller's intended
 * chronological order for drawdown/streak purposes. This function never
 * re-sorts — establishing "chronological" order (e.g. by entryTimestamp or
 * exitTimestamp) is the caller's responsibility, since different callers may
 * legitimately want either ordering.
 *
 * Every division below is guarded against a zero/empty-array denominator and
 * returns a documented safe default instead of throwing or producing
 * NaN/Infinity, except profitFactor, which is `null` by design when there
 * are zero losing trades (or losing trades summing to exactly zero) —
 * genuinely undefined, not 0 and not Infinity. See utils.ts'
 * computeProfitFactor for the exact rule.
 */
export interface TradeAnalyticsMetrics {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: Decimal;
  grossProfit: Decimal;
  grossLoss: Decimal;
  netPnl: Decimal;
  averagePnl: Decimal;
  expectancy: Decimal;
  averageR: Decimal;
  profitFactor: Decimal | null;
  averageWinner: Decimal;
  averageLoser: Decimal;
  largestWinner: Decimal;
  largestLoser: Decimal;
  maxDrawdown: Decimal;
  maxDrawdownPercent: Decimal | null;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  mfeAverage: Decimal | null;
  maeAverage: Decimal | null;
  totalFees: Decimal;
  averageSlippage: Decimal | null;
}

export interface CalculateTradeAnalyticsOptions {
  /**
   * Starting equity for the running equity curve used to compute drawdown.
   * When omitted, the equity curve starts at Decimal(0) and maxDrawdown is
   * still computed (the largest peak-to-trough decline in cumulative
   * netPnl), but maxDrawdownPercent is `null` — there is no real balance to
   * express a percentage against, and fabricating one (e.g. against 0) would
   * be a divide-by-zero or a meaningless number dressed up as real.
   */
  initialBalance?: Decimal;
}

export function calculateTradeAnalytics(
  trades: NormalizedTrade[],
  options: CalculateTradeAnalyticsOptions = {},
): TradeAnalyticsMetrics {
  const tradeCount = trades.length;

  const winners = trades.filter((t) => isWinner(t.netPnl));
  const losers = trades.filter((t) => isLoser(t.netPnl));
  const wins = winners.length;
  const losses = losers.length;

  const winRate = tradeCount === 0 ? new Decimal(0) : new Decimal(wins).dividedBy(tradeCount);

  const grossProfit = winners.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
  // Negative (or zero) by convention — see module doc comment.
  const grossLoss = losers.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
  const netPnl = trades.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));

  const averagePnl = tradeCount === 0 ? new Decimal(0) : netPnl.dividedBy(tradeCount);

  const averageWinner = wins === 0 ? new Decimal(0) : grossProfit.dividedBy(wins);
  const averageLoser = losses === 0 ? new Decimal(0) : grossLoss.dividedBy(losses);

  const profitFactor = computeProfitFactor(grossProfit, grossLoss, losses);

  // expectancy = winRate*averageWinner - (1-winRate)*abs(averageLoser); 0 if no trades.
  const expectancy =
    tradeCount === 0
      ? new Decimal(0)
      : winRate.times(averageWinner).minus(new Decimal(1).minus(winRate).times(averageLoser.abs()));

  const rMultiples = trades.map((t) => t.rMultiple);
  const averageR = averageNonNull(rMultiples) ?? new Decimal(0);

  const largestWinner =
    wins === 0 ? new Decimal(0) : winners.reduce((max, t) => (t.netPnl.greaterThan(max) ? t.netPnl : max), winners[0]!.netPnl);
  // "Largest loser" is the most negative netPnl among losers (magnitude-wise
  // the biggest loss), kept negative per the sign convention above.
  const largestLoser =
    losses === 0 ? new Decimal(0) : losers.reduce((min, t) => (t.netPnl.lessThan(min) ? t.netPnl : min), losers[0]!.netPnl);

  const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(trades, options.initialBalance);
  const { maximumConsecutiveWins, maximumConsecutiveLosses } = calculateConsecutiveStreaks(trades);

  const mfeAverage = averageNonNull(trades.map((t) => t.mfe));
  const maeAverage = averageNonNull(trades.map((t) => t.mae));
  const averageSlippage = averageNonNull(trades.map((t) => t.slippage));
  const totalFees = trades.reduce((sum, t) => sum.plus(t.fees), new Decimal(0));

  return {
    tradeCount,
    wins,
    losses,
    winRate,
    grossProfit,
    grossLoss,
    netPnl,
    averagePnl,
    expectancy,
    averageR,
    profitFactor,
    averageWinner,
    averageLoser,
    largestWinner,
    largestLoser,
    maxDrawdown,
    maxDrawdownPercent,
    maximumConsecutiveWins,
    maximumConsecutiveLosses,
    mfeAverage,
    maeAverage,
    totalFees,
    averageSlippage,
  };
}

/**
 * Builds a running equity curve starting at `initialBalance` (or Decimal(0)
 * when omitted), adding each trade's netPnl in the order given (callers MUST
 * pass trades in their intended chronological order). Tracks the running
 * peak and the largest peak-to-trough decline, in absolute terms always, and
 * in percent terms (relative to the peak equity at the moment of that
 * decline) only when `initialBalance` was supplied — see
 * CalculateTradeAnalyticsOptions' doc comment for why percent has no
 * meaning without a real baseline. If the same absolute decline recurs at a
 * different peak later on (a tie), the FIRST occurrence's percentage is kept
 * (strict `greaterThan`, not `>=`) — deterministic, matching
 * packages/backtester's tie-break exactly.
 */
function calculateMaxDrawdown(
  trades: NormalizedTrade[],
  initialBalance: Decimal | undefined,
): { maxDrawdown: Decimal; maxDrawdownPercent: Decimal | null } {
  const hasBaseline = initialBalance !== undefined;
  let equity = initialBalance ?? new Decimal(0);
  let peak = equity;
  let maxDrawdown = new Decimal(0);
  let maxDrawdownPercent: Decimal | null = hasBaseline ? new Decimal(0) : null;

  for (const trade of trades) {
    equity = equity.plus(trade.netPnl);
    if (equity.greaterThan(peak)) {
      peak = equity;
    }
    const drawdown = peak.minus(equity);
    if (drawdown.greaterThan(maxDrawdown)) {
      maxDrawdown = drawdown;
      if (hasBaseline) {
        maxDrawdownPercent = peak.isZero() ? new Decimal(0) : drawdown.dividedBy(peak).times(100);
      }
    }
  }

  return { maxDrawdown, maxDrawdownPercent };
}

function calculateConsecutiveStreaks(trades: NormalizedTrade[]): {
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
} {
  let maximumConsecutiveWins = 0;
  let maximumConsecutiveLosses = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  for (const trade of trades) {
    if (isWinner(trade.netPnl)) {
      currentWinStreak += 1;
      currentLossStreak = 0;
    } else {
      currentLossStreak += 1;
      currentWinStreak = 0;
    }
    maximumConsecutiveWins = Math.max(maximumConsecutiveWins, currentWinStreak);
    maximumConsecutiveLosses = Math.max(maximumConsecutiveLosses, currentLossStreak);
  }

  return { maximumConsecutiveWins, maximumConsecutiveLosses };
}
