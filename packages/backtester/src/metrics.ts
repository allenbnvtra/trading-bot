import Decimal from "decimal.js";
import type { BacktestMetrics, BacktestTrade } from "@trading-copilot/trading-domain";

/**
 * Sign convention (documented per CLAUDE.md's "document every assumption"
 * rule): grossLoss, largestLoss, and averageLoss are all reported as
 * NEGATIVE Decimals (or zero) — the sum/magnitude of losing trades' netPnl,
 * which is itself <= 0. netProfit = grossProfit + grossLoss under this
 * convention. profitFactor uses grossLoss.abs() as its denominator.
 *
 * Every division below is guarded against a zero denominator and returns a
 * documented safe default instead of throwing or producing NaN/Infinity,
 * except profitFactor, which is `null` by design when there are no losing
 * trades (genuinely undefined, not 0 and not Infinity).
 */
export function calculateBacktestMetrics(
  trades: Array<Pick<BacktestTrade, "netPnl" | "rMultiple">>,
  initialBalance: Decimal,
): Omit<BacktestMetrics, "id" | "backtestId"> {
  const totalTrades = trades.length;

  const winners = trades.filter((t) => t.netPnl.greaterThan(0));
  const losers = trades.filter((t) => t.netPnl.lessThanOrEqualTo(0));
  const winningTrades = winners.length;
  const losingTrades = losers.length;

  const winRate = totalTrades === 0 ? new Decimal(0) : new Decimal(winningTrades).dividedBy(totalTrades);

  const grossProfit = winners.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
  // Negative (or zero) by convention — see module doc comment.
  const grossLoss = losers.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
  const netProfit = trades.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));

  const profitFactor =
    losingTrades === 0 || grossLoss.isZero() ? null : grossProfit.dividedBy(grossLoss.abs());

  const averageTrade = totalTrades === 0 ? new Decimal(0) : netProfit.dividedBy(totalTrades);
  const averageR =
    totalTrades === 0
      ? new Decimal(0)
      : trades.reduce((sum, t) => sum.plus(t.rMultiple), new Decimal(0)).dividedBy(totalTrades);

  const largestWin =
    winningTrades === 0
      ? new Decimal(0)
      : winners.reduce((max, t) => (t.netPnl.greaterThan(max) ? t.netPnl : max), winners[0]!.netPnl);
  // "Largest loss" is the most negative netPnl among losers (magnitude-wise
  // the biggest loss), kept negative per the sign convention above.
  const largestLoss =
    losingTrades === 0
      ? new Decimal(0)
      : losers.reduce((min, t) => (t.netPnl.lessThan(min) ? t.netPnl : min), losers[0]!.netPnl);

  const averageWin = winningTrades === 0 ? new Decimal(0) : grossProfit.dividedBy(winningTrades);
  const averageLoss = losingTrades === 0 ? new Decimal(0) : grossLoss.dividedBy(losingTrades);

  const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(trades, initialBalance);
  const { maximumConsecutiveWins, maximumConsecutiveLosses } = calculateConsecutiveStreaks(trades);

  // expectancy = winRate*averageWin - (1-winRate)*abs(averageLoss); 0 if no trades.
  const expectancy =
    totalTrades === 0
      ? new Decimal(0)
      : winRate.times(averageWin).minus(new Decimal(1).minus(winRate).times(averageLoss.abs()));

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor,
    averageTrade,
    averageR,
    largestWin,
    largestLoss,
    averageWin,
    averageLoss,
    maxDrawdown,
    maxDrawdownPercent,
    maximumConsecutiveWins,
    maximumConsecutiveLosses,
    expectancy,
  };
}

/**
 * Builds a running equity curve starting at initialBalance, adding each
 * trade's netPnl in the order given (callers MUST pass trades in
 * chronological order). Tracks the running peak and the largest
 * peak-to-trough decline, in both absolute and percent terms (percent is
 * relative to the peak equity at the moment of that decline — the standard
 * drawdown definition). If the same absolute decline recurs at a different
 * peak later on (a tie), the FIRST occurrence's percentage is kept (strict
 * `greaterThan`, not `>=`) — deterministic, but note maxDrawdownPercent is
 * therefore always paired with whichever point first set the maxDrawdown
 * record, not independently re-maximized.
 */
function calculateMaxDrawdown(
  trades: Array<Pick<BacktestTrade, "netPnl">>,
  initialBalance: Decimal,
): { maxDrawdown: Decimal; maxDrawdownPercent: Decimal } {
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = new Decimal(0);
  let maxDrawdownPercent = new Decimal(0);

  for (const trade of trades) {
    equity = equity.plus(trade.netPnl);
    if (equity.greaterThan(peak)) {
      peak = equity;
    }
    const drawdown = peak.minus(equity);
    if (drawdown.greaterThan(maxDrawdown)) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = peak.isZero() ? new Decimal(0) : drawdown.dividedBy(peak).times(100);
    }
  }

  return { maxDrawdown, maxDrawdownPercent };
}

function calculateConsecutiveStreaks(
  trades: Array<Pick<BacktestTrade, "netPnl">>,
): { maximumConsecutiveWins: number; maximumConsecutiveLosses: number } {
  let maximumConsecutiveWins = 0;
  let maximumConsecutiveLosses = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  for (const trade of trades) {
    if (trade.netPnl.greaterThan(0)) {
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
