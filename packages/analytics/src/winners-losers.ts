import Decimal from "decimal.js";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { averageNonNull, computeProfitFactor, isLoser, isWinner } from "./utils";

/**
 * Per docs/research-methodology.md's "Winner/loser comparison discipline"
 * and docs/trade-journal-design.md: a condition that is common among losing
 * trades is not automatically a *cause* of losses — it may be equally common
 * among winners, or common in the underlying population of all setups. This
 * module reports numbers only (sample sizes, prevalence, averageR,
 * profitFactor, winRate) and draws no causal or evaluative conclusion
 * anywhere in its code. Interpretation is a human/AI-summary concern layered
 * on top elsewhere — never inside this deterministic package.
 */
export interface GroupComparisonStats {
  sampleSize: number;
  /** Average of trades' non-null rMultiple in this group; Decimal(0) if none have a non-null rMultiple. */
  averageR: Decimal;
  /** Same null-vs-zero convention as calculateTradeAnalytics — see utils.ts' computeProfitFactor. */
  profitFactor: Decimal | null;
  /** Decimal(0) if sampleSize is 0. */
  winRate: Decimal;
}

export interface WinnerLoserComparison {
  winners: GroupComparisonStats;
  losers: GroupComparisonStats;
  allTrades: GroupComparisonStats;
  /** Present only when a condition predicate was supplied. */
  condition?: {
    /** Fraction 0-1 of winners for which the predicate is true; Decimal(0) if there are no winners. */
    prevalenceAmongWinners: Decimal;
    /** Fraction 0-1 of losers for which the predicate is true; Decimal(0) if there are no losers. */
    prevalenceAmongLosers: Decimal;
    /** Fraction 0-1 of all trades for which the predicate is true; Decimal(0) if there are no trades. */
    prevalenceAmongAll: Decimal;
    withCondition: GroupComparisonStats;
    withoutCondition: GroupComparisonStats;
  };
}

function computeGroupStats(trades: NormalizedTrade[]): GroupComparisonStats {
  const sampleSize = trades.length;
  const winRate =
    sampleSize === 0 ? new Decimal(0) : new Decimal(trades.filter((t) => isWinner(t.netPnl)).length).dividedBy(sampleSize);
  const averageR = averageNonNull(trades.map((t) => t.rMultiple)) ?? new Decimal(0);

  const winners = trades.filter((t) => isWinner(t.netPnl));
  const losers = trades.filter((t) => isLoser(t.netPnl));
  const grossProfit = winners.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
  const grossLoss = losers.reduce((sum, t) => sum.plus(t.netPnl), new Decimal(0));
  const profitFactor = computeProfitFactor(grossProfit, grossLoss, losers.length);

  return { sampleSize, averageR, profitFactor, winRate };
}

/** Fraction 0-1 of `trades` for which `predicate` is true; Decimal(0) if `trades` is empty. */
function prevalence(trades: NormalizedTrade[], predicate: (trade: NormalizedTrade) => boolean): Decimal {
  if (trades.length === 0) {
    return new Decimal(0);
  }
  return new Decimal(trades.filter(predicate).length).dividedBy(trades.length);
}

/**
 * Compares winners, losers, and all trades on sample size, averageR,
 * profitFactor, and winRate — and, when `condition` is supplied, additionally
 * reports the condition's prevalence across each of those three populations
 * plus a with/without-condition comparison over all trades. A "winner" is
 * netPnl > 0, a "loser" is netPnl <= 0 (matching packages/backtester and
 * metrics.ts exactly — a breakeven trade counts as a loser).
 *
 * This function computes numbers only. It never labels a condition as a
 * "cause". Reading prevalenceAmongWinners vs prevalenceAmongLosers side by
 * side is what lets a human or AI summary layer apply the discipline in
 * docs/research-methodology.md; this module does not apply it for them.
 */
export function compareWinnersLosers(
  trades: NormalizedTrade[],
  condition?: (trade: NormalizedTrade) => boolean,
): WinnerLoserComparison {
  const winnerTrades = trades.filter((t) => isWinner(t.netPnl));
  const loserTrades = trades.filter((t) => isLoser(t.netPnl));

  const result: WinnerLoserComparison = {
    winners: computeGroupStats(winnerTrades),
    losers: computeGroupStats(loserTrades),
    allTrades: computeGroupStats(trades),
  };

  if (condition) {
    const withCondition = trades.filter(condition);
    const withoutCondition = trades.filter((t) => !condition(t));

    result.condition = {
      prevalenceAmongWinners: prevalence(winnerTrades, condition),
      prevalenceAmongLosers: prevalence(loserTrades, condition),
      prevalenceAmongAll: prevalence(trades, condition),
      withCondition: computeGroupStats(withCondition),
      withoutCondition: computeGroupStats(withoutCondition),
    };
  }

  return result;
}
