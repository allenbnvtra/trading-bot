import { NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backtest, Instrument, StrategyVersion } from "@trading-copilot/trading-domain";
import { BacktestService } from "./backtest.service";

const { instrumentsRepository, strategiesRepository, backtestsRepository, candlesRepository } = vi.hoisted(
  () => ({
    instrumentsRepository: { getInstrument: vi.fn() },
    strategiesRepository: { getStrategyVersion: vi.fn() },
    backtestsRepository: {
      createBacktest: vi.fn(),
      listBacktests: vi.fn(),
      getBacktest: vi.fn(),
      getBacktestMetrics: vi.fn(),
      listBacktestTrades: vi.fn(),
      getBacktestTrade: vi.fn(),
    },
    candlesRepository: { getSurroundingCandles: vi.fn() },
  }),
);

vi.mock("@trading-copilot/database", () => ({
  instrumentsRepository,
  strategiesRepository,
  backtestsRepository,
  candlesRepository,
}));

function makeInstrument(): Instrument {
  return {
    id: "instrument-1",
    symbol: "GENFUT1",
    name: "Generic Future",
    assetClass: "FUTURES",
    exchange: "SIM-FUT",
    currency: "USD",
    tickSize: new Decimal("0.25"),
    tickValue: new Decimal("12.5"),
    pointValue: new Decimal("50"),
    commissionPerContract: new Decimal("2.5"),
    timezone: "UTC",
    sessionConfiguration: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeStrategyVersion(): StrategyVersion {
  return {
    id: "strategy-version-1",
    strategyId: "strategy-1",
    version: "1.0.0",
    name: "EMA Trend Pullback",
    description: "",
    parameters: {},
    status: "BACKTESTING",
    createdAt: new Date(),
    sourceHypothesisId: null,
  };
}

function makeBacktest(): Backtest {
  return {
    id: "backtest-1",
    strategyVersionId: "strategy-version-1",
    instrumentId: "instrument-1",
    timeframe: "1h",
    startDate: new Date("2024-01-01T00:00:00.000Z"),
    endDate: new Date("2024-02-01T00:00:00.000Z"),
    status: "QUEUED",
    assumptions: {
      commissionPerContract: "2.5",
      slippageTicks: 0,
      riskPercentage: "1",
      initialBalance: "10000",
    },
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    createdAt: new Date(),
  };
}

describe("BacktestService", () => {
  let queueAdd: ReturnType<typeof vi.fn>;
  let service: BacktestService;

  beforeEach(() => {
    vi.clearAllMocks();
    queueAdd = vi.fn().mockResolvedValue(undefined);
    service = new BacktestService({ add: queueAdd } as never);
  });

  describe("create", () => {
    it("404s when the instrument does not exist", async () => {
      instrumentsRepository.getInstrument.mockResolvedValue(null);

      await expect(
        service.create({
          instrumentId: "missing-instrument",
          strategyVersionId: "strategy-version-1",
          timeframe: "1h",
          startDate: "2024-01-01T00:00:00.000Z",
          endDate: "2024-02-01T00:00:00.000Z",
          initialBalance: "10000",
          riskPercentage: "1",
          slippageTicks: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(strategiesRepository.getStrategyVersion).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it("404s when the strategy version does not exist", async () => {
      instrumentsRepository.getInstrument.mockResolvedValue(makeInstrument());
      strategiesRepository.getStrategyVersion.mockResolvedValue(null);

      await expect(
        service.create({
          instrumentId: "instrument-1",
          strategyVersionId: "missing-version",
          timeframe: "1h",
          startDate: "2024-01-01T00:00:00.000Z",
          endDate: "2024-02-01T00:00:00.000Z",
          initialBalance: "10000",
          riskPercentage: "1",
          slippageTicks: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(queueAdd).not.toHaveBeenCalled();
    });

    it("creates the backtest with real assumptions and enqueues a run job", async () => {
      const instrument = makeInstrument();
      const strategyVersion = makeStrategyVersion();
      const backtest = makeBacktest();

      instrumentsRepository.getInstrument.mockResolvedValue(instrument);
      strategiesRepository.getStrategyVersion.mockResolvedValue(strategyVersion);
      backtestsRepository.createBacktest.mockResolvedValue(backtest);

      const result = await service.create({
        instrumentId: "instrument-1",
        strategyVersionId: "strategy-version-1",
        timeframe: "1h",
        startDate: "2024-01-01T00:00:00.000Z",
        endDate: "2024-02-01T00:00:00.000Z",
        initialBalance: "10000",
        riskPercentage: "1",
        slippageTicks: 2,
      });

      expect(backtestsRepository.createBacktest).toHaveBeenCalledWith(
        expect.objectContaining({
          strategyVersionId: "strategy-version-1",
          instrumentId: "instrument-1",
          timeframe: "1h",
          assumptions: {
            commissionPerContract: "2.5",
            slippageTicks: 2,
            riskPercentage: "1",
            initialBalance: "10000",
          },
        }),
      );
      expect(queueAdd).toHaveBeenCalledWith("run", { backtestId: backtest.id });
      expect(result).toBe(backtest);
    });
  });

  describe("getById", () => {
    it("404s when the backtest does not exist", async () => {
      backtestsRepository.getBacktest.mockResolvedValue(null);
      await expect(service.getById("missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("merges metrics into the backtest response, defaulting to null", async () => {
      const backtest = makeBacktest();
      backtestsRepository.getBacktest.mockResolvedValue(backtest);
      backtestsRepository.getBacktestMetrics.mockResolvedValue(null);

      const result = await service.getById(backtest.id);
      expect(result).toEqual({ ...backtest, metrics: null });
    });
  });

  describe("getTrade", () => {
    it("404s when the parent backtest does not exist", async () => {
      backtestsRepository.getBacktest.mockResolvedValue(null);
      await expect(service.getTrade("missing-backtest", "trade-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(backtestsRepository.getBacktestTrade).not.toHaveBeenCalled();
    });

    it("404s when the trade does not exist on that backtest", async () => {
      backtestsRepository.getBacktest.mockResolvedValue(makeBacktest());
      backtestsRepository.getBacktestTrade.mockResolvedValue(null);
      await expect(service.getTrade("backtest-1", "missing-trade")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the trade with surrounding candle data", async () => {
      const backtest = makeBacktest();
      const trade = {
        id: "trade-1",
        instrumentId: "instrument-1",
        entryTimestamp: new Date("2024-01-05T00:00:00.000Z"),
      };
      backtestsRepository.getBacktest.mockResolvedValue(backtest);
      backtestsRepository.getBacktestTrade.mockResolvedValue(trade);
      candlesRepository.getSurroundingCandles.mockResolvedValue(["candle-a", "candle-b"]);

      const result = await service.getTrade(backtest.id, trade.id);

      expect(candlesRepository.getSurroundingCandles).toHaveBeenCalledWith(
        "instrument-1",
        "1h",
        trade.entryTimestamp,
        20,
        20,
      );
      expect(result).toEqual({ trade, surroundingCandles: ["candle-a", "candle-b"] });
    });
  });
});
