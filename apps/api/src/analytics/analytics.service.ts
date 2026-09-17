import { Injectable } from "@nestjs/common";
import {
  getNormalizedTrades,
  strategiesRepository,
  type NormalizedTradeFilters,
} from "@trading-copilot/database";
import type { AnalyticsQuery } from "@trading-copilot/shared-types";
import {
  calculateTradeAnalytics,
  compareWinnersLosers,
  DEFAULT_GROUP_BY,
  groupTradeAnalytics,
  type AnalyticsGroup,
  type GroupByField,
  type TradeAnalyticsMetrics,
} from "@trading-copilot/analytics";
import type { AnalyticsComparisonQuery } from "./analytics.schemas";

export interface StrategyGroupSummary {
  strategyId: string | null;
  strategyName: string | null;
  strategyVersionId: string | null;
  version: string | null;
  metrics: TradeAnalyticsMetrics;
}

function toNormalizedTradeFilters(query: AnalyticsQuery): NormalizedTradeFilters {
  return {
    strategyId: query.strategyId,
    strategyVersionId: query.strategyVersionId,
    instrumentId: query.instrumentId,
    direction: query.direction,
    executionMode: query.executionMode,
    dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
    dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
  };
}

@Injectable()
export class AnalyticsService {
  /**
   * Never call getNormalizedTrades directly for any endpoint below except
   * through this shared path — it is the only sanctioned cross-cutting
   * trade source (see analytics-adapter.ts).
   */
  async strategiesOverview(): Promise<StrategyGroupSummary[]> {
    const trades = await getNormalizedTrades({});
    const groups = groupTradeAnalytics(trades, DEFAULT_GROUP_BY);
    return this.attachStrategyNames(groups);
  }

  async strategyOverview(strategyId: string): Promise<StrategyGroupSummary[]> {
    const trades = await getNormalizedTrades({ strategyId });
    // Still grouped by (strategyId, strategyVersionId) — a single strategy
    // can have multiple versions, and versions are never silently combined.
    const groups = groupTradeAnalytics(trades, DEFAULT_GROUP_BY);
    return this.attachStrategyNames(groups);
  }

  async strategyVersionDetail(strategyId: string, strategyVersionId: string) {
    const trades = await getNormalizedTrades({ strategyId, strategyVersionId });
    return {
      metrics: calculateTradeAnalytics(trades),
      byDirection: {
        LONG: calculateTradeAnalytics(trades.filter((trade) => trade.direction === "LONG")),
        SHORT: calculateTradeAnalytics(trades.filter((trade) => trade.direction === "SHORT")),
      },
      winnersLosers: compareWinnersLosers(trades),
      trades,
    };
  }

  async comparison(query: AnalyticsComparisonQuery): Promise<AnalyticsGroup[]> {
    const filters = toNormalizedTradeFilters(query);
    const trades = await getNormalizedTrades(filters);
    const groupBy = (query.groupBy ?? DEFAULT_GROUP_BY) as GroupByField[];
    return groupTradeAnalytics(trades, groupBy);
  }

  async winnersLosers(query: AnalyticsQuery) {
    const filters = toNormalizedTradeFilters(query);
    const trades = await getNormalizedTrades(filters);
    // No `condition` predicate: HTTP query strings can't carry a function —
    // base three-way (winners/losers/all) comparison only.
    return compareWinnersLosers(trades);
  }

  /**
   * Resolves strategy name + version string for each group's ids. Batched
   * by distinct strategyId (one getStrategyWithVersions call per distinct
   * strategy, not per group/version) rather than N+1 per group.
   */
  private async attachStrategyNames(groups: AnalyticsGroup[]): Promise<StrategyGroupSummary[]> {
    const distinctStrategyIds = [...new Set(groups.map((group) => group.key.strategyId).filter((id): id is string => !!id))];

    const strategies = await Promise.all(
      distinctStrategyIds.map((strategyId) => strategiesRepository.getStrategyWithVersions(strategyId)),
    );
    const strategyById = new Map(strategies.filter((strategy) => strategy !== null).map((strategy) => [strategy.id, strategy]));

    return groups.map((group) => {
      const strategyId = group.key.strategyId ?? null;
      const strategyVersionId = group.key.strategyVersionId ?? null;
      const strategy = strategyId ? strategyById.get(strategyId) : undefined;
      const version = strategy?.versions.find((candidate) => candidate.id === strategyVersionId);

      return {
        strategyId,
        strategyName: strategy?.name ?? null,
        strategyVersionId,
        version: version?.version ?? null,
        metrics: group.metrics,
      };
    });
  }
}
