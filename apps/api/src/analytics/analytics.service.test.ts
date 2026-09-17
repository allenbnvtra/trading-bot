import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsService } from "./analytics.service";

const { getNormalizedTrades, strategiesRepository } = vi.hoisted(() => ({
  getNormalizedTrades: vi.fn(),
  strategiesRepository: { getStrategyWithVersions: vi.fn() },
}));

const { groupTradeAnalytics, calculateTradeAnalytics, compareWinnersLosers, DEFAULT_GROUP_BY } = vi.hoisted(
  () => ({
    groupTradeAnalytics: vi.fn(),
    calculateTradeAnalytics: vi.fn(),
    compareWinnersLosers: vi.fn(),
    DEFAULT_GROUP_BY: ["strategyId", "strategyVersionId"],
  }),
);

vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>(
    "@trading-copilot/database",
  );
  return { ...actual, getNormalizedTrades, strategiesRepository };
});

vi.mock("@trading-copilot/analytics", () => ({
  groupTradeAnalytics,
  calculateTradeAnalytics,
  compareWinnersLosers,
  DEFAULT_GROUP_BY,
}));

describe("AnalyticsService", () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService();
  });

  describe("strategiesOverview", () => {
    it("wires no filters through getNormalizedTrades, groups by DEFAULT_GROUP_BY, and batches strategy lookups once per distinct strategy", async () => {
      const trades = [{ id: "trade-1" }];
      getNormalizedTrades.mockResolvedValue(trades);
      groupTradeAnalytics.mockReturnValue([
        { key: { strategyId: "strategy-1", strategyVersionId: "version-1" }, metrics: { tradeCount: 1 }, trades },
        { key: { strategyId: "strategy-1", strategyVersionId: "version-2" }, metrics: { tradeCount: 2 }, trades },
      ]);
      strategiesRepository.getStrategyWithVersions.mockResolvedValue({
        id: "strategy-1",
        name: "EMA Trend Pullback",
        versions: [
          { id: "version-1", version: "1.0.0" },
          { id: "version-2", version: "2.0.0" },
        ],
      });

      const result = await service.strategiesOverview();

      expect(getNormalizedTrades).toHaveBeenCalledWith({});
      expect(groupTradeAnalytics).toHaveBeenCalledWith(trades, DEFAULT_GROUP_BY);
      // Two groups, same strategyId -> exactly one lookup call, not N+1.
      expect(strategiesRepository.getStrategyWithVersions).toHaveBeenCalledTimes(1);
      expect(strategiesRepository.getStrategyWithVersions).toHaveBeenCalledWith("strategy-1");
      expect(result).toEqual([
        {
          strategyId: "strategy-1",
          strategyName: "EMA Trend Pullback",
          strategyVersionId: "version-1",
          version: "1.0.0",
          metrics: { tradeCount: 1 },
        },
        {
          strategyId: "strategy-1",
          strategyName: "EMA Trend Pullback",
          strategyVersionId: "version-2",
          version: "2.0.0",
          metrics: { tradeCount: 2 },
        },
      ]);
    });
  });

  describe("strategyOverview", () => {
    it("filters getNormalizedTrades by strategyId and still groups by DEFAULT_GROUP_BY", async () => {
      getNormalizedTrades.mockResolvedValue([]);
      groupTradeAnalytics.mockReturnValue([]);

      await service.strategyOverview("strategy-1");

      expect(getNormalizedTrades).toHaveBeenCalledWith({ strategyId: "strategy-1" });
      expect(groupTradeAnalytics).toHaveBeenCalledWith([], DEFAULT_GROUP_BY);
    });
  });

  describe("strategyVersionDetail", () => {
    it("filters by strategyId + strategyVersionId and returns metrics/byDirection/winnersLosers/trades", async () => {
      const longTrade = { direction: "LONG" };
      const shortTrade = { direction: "SHORT" };
      const trades = [longTrade, shortTrade];
      getNormalizedTrades.mockResolvedValue(trades);
      calculateTradeAnalytics.mockImplementation((input: unknown[]) => ({ tradeCount: input.length }));
      compareWinnersLosers.mockReturnValue({ winners: {}, losers: {}, allTrades: {} });

      const result = await service.strategyVersionDetail("strategy-1", "version-1");

      expect(getNormalizedTrades).toHaveBeenCalledWith({
        strategyId: "strategy-1",
        strategyVersionId: "version-1",
      });
      expect(calculateTradeAnalytics).toHaveBeenCalledWith(trades);
      expect(calculateTradeAnalytics).toHaveBeenCalledWith([longTrade]);
      expect(calculateTradeAnalytics).toHaveBeenCalledWith([shortTrade]);
      expect(result.metrics).toEqual({ tradeCount: 2 });
      expect(result.byDirection.LONG).toEqual({ tradeCount: 1 });
      expect(result.byDirection.SHORT).toEqual({ tradeCount: 1 });
      expect(result.winnersLosers).toEqual({ winners: {}, losers: {}, allTrades: {} });
      expect(result.trades).toBe(trades);
    });
  });

  describe("comparison", () => {
    it("converts date filters and defaults groupBy to DEFAULT_GROUP_BY when omitted", async () => {
      getNormalizedTrades.mockResolvedValue([]);
      groupTradeAnalytics.mockReturnValue([]);

      await service.comparison({
        strategyId: "strategy-1",
        dateFrom: "2024-01-01T00:00:00.000Z",
        dateTo: "2024-02-01T00:00:00.000Z",
      } as never);

      expect(getNormalizedTrades).toHaveBeenCalledWith({
        strategyId: "strategy-1",
        strategyVersionId: undefined,
        instrumentId: undefined,
        direction: undefined,
        executionMode: undefined,
        dateFrom: new Date("2024-01-01T00:00:00.000Z"),
        dateTo: new Date("2024-02-01T00:00:00.000Z"),
      });
      expect(groupTradeAnalytics).toHaveBeenCalledWith([], DEFAULT_GROUP_BY);
    });

    it("passes an explicit groupBy straight through", async () => {
      getNormalizedTrades.mockResolvedValue([]);
      groupTradeAnalytics.mockReturnValue([]);

      await service.comparison({ groupBy: ["strategyId", "direction"] } as never);

      expect(groupTradeAnalytics).toHaveBeenCalledWith([], ["strategyId", "direction"]);
    });
  });

  describe("winnersLosers", () => {
    it("wires filters through getNormalizedTrades and calls compareWinnersLosers with no condition", async () => {
      const trades = [{ id: "trade-1" }];
      getNormalizedTrades.mockResolvedValue(trades);
      compareWinnersLosers.mockReturnValue({ winners: {}, losers: {}, allTrades: {} });

      await service.winnersLosers({ instrumentId: "instrument-1" } as never);

      expect(getNormalizedTrades).toHaveBeenCalledWith({
        strategyId: undefined,
        strategyVersionId: undefined,
        instrumentId: "instrument-1",
        direction: undefined,
        executionMode: undefined,
        dateFrom: undefined,
        dateTo: undefined,
      });
      expect(compareWinnersLosers).toHaveBeenCalledWith(trades);
      expect(compareWinnersLosers).toHaveBeenCalledTimes(1);
    });
  });
});
