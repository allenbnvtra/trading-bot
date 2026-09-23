import Decimal from "decimal.js";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { calculateTradeAnalytics, type TradeAnalyticsMetrics } from "./metrics";
import { averageNonNull, isLoser, isWinner } from "./utils";

/**
 * Only populated for a JOURNAL-sourced trade whose JournalTrade had a
 * setupId (a MarketSnapshot-backed Setup); a purely manual journal entry,
 * or any BACKTEST-sourced trade (backtests are not tied to a Setup), has
 * `context: null`. This is a real limitation, not an oversight: see
 * docs/ai-research.md "What the ResearchAgent can and cannot see".
 */
export interface EnrichedJournalTradeContext {
  session: string | null;
  timeOfDay: string | null;
  marketRegime: string | null;
  vwapDistance: Decimal | null;
  volumePercentile: Decimal | null;
  atrPercentile: Decimal | null;
}

export interface EnrichedJournalTrade extends NormalizedTrade {
  context: EnrichedJournalTradeContext | null;
}

export interface CategoricalBreakdown {
  value: string;
  sampleSize: number;
  winRate: Decimal;
  averageR: Decimal;
  profitFactor: Decimal | null;
}

export interface ContinuousVariableComparison {
  averageAmongWinners: Decimal | null;
  averageAmongLosers: Decimal | null;
  averageAmongAll: Decimal | null;
}

export interface ResearchDataSummary {
  overall: TradeAnalyticsMetrics;
  sampleWindowStart: Date | null;
  sampleWindowEnd: Date | null;
  bySession: CategoricalBreakdown[];
  byTimeOfDay: CategoricalBreakdown[];
  byMarketRegime: CategoricalBreakdown[];
  byDirection: CategoricalBreakdown[];
  vwapDistance: ContinuousVariableComparison;
  volumePercentile: ContinuousVariableComparison;
  atrPercentile: ContinuousVariableComparison;
}

const UNKNOWN = "UNKNOWN";

function breakdownByKey(
  trades: EnrichedJournalTrade[],
  keyOf: (trade: EnrichedJournalTrade) => string | null,
): CategoricalBreakdown[] {
  const buckets = new Map<string, EnrichedJournalTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade) ?? UNKNOWN;
    const bucket = buckets.get(key) ?? [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries()).map(([value, bucketTrades]) => {
    const metrics = calculateTradeAnalytics(bucketTrades);
    return {
      value,
      sampleSize: bucketTrades.length,
      winRate: metrics.winRate,
      averageR: metrics.averageR,
      profitFactor: metrics.profitFactor,
    };
  });
}

function continuousComparison(
  trades: EnrichedJournalTrade[],
  valueOf: (trade: EnrichedJournalTrade) => Decimal | null,
): ContinuousVariableComparison {
  const winners = trades.filter((t) => isWinner(t.netPnl));
  const losers = trades.filter((t) => isLoser(t.netPnl));
  return {
    averageAmongWinners: averageNonNull(winners.map(valueOf)),
    averageAmongLosers: averageNonNull(losers.map(valueOf)),
    averageAmongAll: averageNonNull(trades.map(valueOf)),
  };
}

/**
 * The deterministic, non-AI statistics layer the ResearchAgent consumes,
 * per docs/research-methodology.md "AI interprets these statistics. It
 * does NOT calculate." Callers pass already-filtered/chronologically
 * ordered trades (see repositories/research.ts'
 * listEnrichedJournalTradesForResearch).
 */
export function buildResearchDataSummary(trades: EnrichedJournalTrade[]): ResearchDataSummary {
  const overall = calculateTradeAnalytics(trades);
  const timestamps = trades.map((t) => t.entryTimestamp.getTime());

  return {
    overall,
    sampleWindowStart: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null,
    sampleWindowEnd: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null,
    bySession: breakdownByKey(trades, (t) => t.context?.session ?? null),
    byTimeOfDay: breakdownByKey(trades, (t) => t.context?.timeOfDay ?? null),
    byMarketRegime: breakdownByKey(trades, (t) => t.context?.marketRegime ?? null),
    byDirection: breakdownByKey(trades, (t) => t.direction),
    vwapDistance: continuousComparison(trades, (t) => t.context?.vwapDistance ?? null),
    volumePercentile: continuousComparison(trades, (t) => t.context?.volumePercentile ?? null),
    atrPercentile: continuousComparison(trades, (t) => t.context?.atrPercentile ?? null),
  };
}

/** Example starting guardrails per docs/research-methodology.md: configurable, not mathematical guarantees. */
export const MINIMUM_CALENDAR_DAYS = 60;
export const MINIMUM_CANDIDATE_SETUPS = 100;

export interface SampleSizeGuardrailResult {
  passes: boolean;
  calendarDays: number;
  setupCount: number;
  reasons: string[];
}

/**
 * Gates VALIDATION/FINAL_TEST/WALK_FORWARD experiment creation and the
 * PAPER_CANDIDATE transition; see apps/api/src/research/research.service.ts.
 * Both conditions are required, never either alone (see
 * docs/research-methodology.md "Sample size guardrails").
 */
export function assertSampleSizeGuardrails(summary: {
  sampleWindowStart: Date | null;
  sampleWindowEnd: Date | null;
  overall: { tradeCount: number };
}): SampleSizeGuardrailResult {
  const calendarDays =
    summary.sampleWindowStart && summary.sampleWindowEnd
      ? Math.floor(
          (summary.sampleWindowEnd.getTime() - summary.sampleWindowStart.getTime()) / (1000 * 60 * 60 * 24),
        )
      : 0;
  const setupCount = summary.overall.tradeCount;

  const reasons: string[] = [];
  if (calendarDays < MINIMUM_CALENDAR_DAYS) {
    reasons.push(`only ${calendarDays} calendar days of data (minimum ${MINIMUM_CALENDAR_DAYS})`);
  }
  if (setupCount < MINIMUM_CANDIDATE_SETUPS) {
    reasons.push(`only ${setupCount} candidate setups (minimum ${MINIMUM_CANDIDATE_SETUPS})`);
  }

  return { passes: reasons.length === 0, calendarDays, setupCount, reasons };
}
