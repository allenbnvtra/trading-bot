import Decimal from "decimal.js";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { calculateTradeAnalytics, type TradeAnalyticsMetrics } from "./metrics";

export type GroupByField =
  | "strategyId"
  | "strategyVersionId"
  | "instrumentId"
  | "direction"
  | "executionMode";

export interface AnalyticsGroup {
  key: Partial<Record<GroupByField, string>>;
  metrics: TradeAnalyticsMetrics;
  /** The trades that fell into this group, in the order they appeared in the input, for drill-down. */
  trades: NormalizedTrade[];
}

/**
 * The safe, non-silent default grouping: one group per distinct
 * (strategyId, strategyVersionId) pair. Strategy versions are immutable and
 * never comparable to each other by default (see CLAUDE.md / the
 * research-methodology doc) — a version bump can change entry/exit rules
 * entirely, so aggregating across versions changes what a metric *means*.
 *
 * A caller that passes a coarser `groupBy` to groupTradeAnalytics (e.g.
 * `["strategyId"]` alone, merging every version of a strategy together) is
 * making an explicit, visible choice to do that aggregation — that's a
 * legitimate thing to want (e.g. "how has this strategy done across all its
 * versions over its lifetime"), it just must never happen by *default*.
 * "Silent" combination would mean defaulting to the coarser grouping without
 * the caller asking for it, which this constant exists to prevent.
 */
export const DEFAULT_GROUP_BY: GroupByField[] = ["strategyId", "strategyVersionId"];

export interface GroupTradeAnalyticsOptions {
  initialBalance?: Decimal;
}

/**
 * Partitions `trades` by the exact combination of the requested `groupBy`
 * fields (e.g. `["strategyId", "strategyVersionId"]` produces one group per
 * distinct pair — two trades land in the same group only if ALL requested
 * fields match), then runs calculateTradeAnalytics on each partition.
 *
 * Group order is deterministic: groups appear in the order their key
 * combination is first encountered while scanning `trades` in the given
 * order (a Map is used internally to preserve insertion order). Trades
 * within each group preserve their relative order from the input, which
 * matters because calculateTradeAnalytics treats trade order as
 * chronological for drawdown/streak purposes — see metrics.ts. If the input
 * isn't already chronological, sort it before calling this function.
 *
 * `groupBy` must be non-empty; an empty array would silently produce one
 * group containing every trade (an unrequested aggregation across
 * everything, including different strategy versions), which this function
 * refuses rather than doing implicitly.
 */
export function groupTradeAnalytics(
  trades: NormalizedTrade[],
  groupBy: GroupByField[],
  options: GroupTradeAnalyticsOptions = {},
): AnalyticsGroup[] {
  if (groupBy.length === 0) {
    throw new Error(
      "groupTradeAnalytics requires at least one groupBy field; an empty array would silently " +
        "aggregate all trades together, including across different strategy versions.",
    );
  }

  const order: string[] = [];
  const buckets = new Map<string, { key: Partial<Record<GroupByField, string>>; trades: NormalizedTrade[] }>();

  for (const trade of trades) {
    const key: Partial<Record<GroupByField, string>> = {};
    for (const field of groupBy) {
      key[field] = trade[field];
    }
    const compositeKey = groupBy.map((field) => `${field}=${key[field]}`).join("|");

    let bucket = buckets.get(compositeKey);
    if (!bucket) {
      bucket = { key, trades: [] };
      buckets.set(compositeKey, bucket);
      order.push(compositeKey);
    }
    bucket.trades.push(trade);
  }

  return order.map((compositeKey) => {
    const bucket = buckets.get(compositeKey)!;
    return {
      key: bucket.key,
      metrics: calculateTradeAnalytics(bucket.trades, options),
      trades: bucket.trades,
    };
  });
}
