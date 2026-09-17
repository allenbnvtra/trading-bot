import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  backtestsRepository,
  candlesRepository,
  instrumentsRepository,
  strategiesRepository,
} from "@trading-copilot/database";
import type { CreateBacktestRequestInput } from "@trading-copilot/shared-types";
import type { Backtest, BacktestAssumptions } from "@trading-copilot/trading-domain";
import { BACKTEST_RUN_JOB, BACKTEST_RUN_QUEUE, type BacktestRunJobPayload } from "../common/queue.constants";

@Injectable()
export class BacktestService {
  constructor(
    @InjectQueue(BACKTEST_RUN_QUEUE)
    private readonly backtestQueue: Queue<BacktestRunJobPayload>,
  ) {}

  async create(input: CreateBacktestRequestInput): Promise<Backtest> {
    const instrument = await instrumentsRepository.getInstrument(input.instrumentId);
    if (!instrument) {
      throw new NotFoundException(`Instrument ${input.instrumentId} not found`);
    }

    const strategyVersion = await strategiesRepository.getStrategyVersion(input.strategyVersionId);
    if (!strategyVersion) {
      throw new NotFoundException(`Strategy version ${input.strategyVersionId} not found`);
    }

    const assumptions: BacktestAssumptions = {
      commissionPerContract: instrument.commissionPerContract.toString(),
      slippageTicks: input.slippageTicks,
      riskPercentage: input.riskPercentage,
      initialBalance: input.initialBalance,
    };

    const backtest = await backtestsRepository.createBacktest({
      strategyVersionId: input.strategyVersionId,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      assumptions,
    });

    await this.backtestQueue.add(BACKTEST_RUN_JOB, { backtestId: backtest.id });

    return backtest;
  }

  list(): Promise<Backtest[]> {
    return backtestsRepository.listBacktests();
  }

  async getById(id: string) {
    const backtest = await backtestsRepository.getBacktest(id);
    if (!backtest) {
      throw new NotFoundException(`Backtest ${id} not found`);
    }
    const metrics = await backtestsRepository.getBacktestMetrics(id);
    return { ...backtest, metrics: metrics ?? null };
  }

  async listTrades(backtestId: string) {
    const backtest = await backtestsRepository.getBacktest(backtestId);
    if (!backtest) {
      throw new NotFoundException(`Backtest ${backtestId} not found`);
    }
    return backtestsRepository.listBacktestTrades(backtestId);
  }

  async getTrade(backtestId: string, tradeId: string) {
    const backtest = await backtestsRepository.getBacktest(backtestId);
    if (!backtest) {
      throw new NotFoundException(`Backtest ${backtestId} not found`);
    }

    const trade = await backtestsRepository.getBacktestTrade(backtestId, tradeId);
    if (!trade) {
      throw new NotFoundException(`Trade ${tradeId} not found on backtest ${backtestId}`);
    }

    const surroundingCandles = await candlesRepository.getSurroundingCandles(
      trade.instrumentId,
      backtest.timeframe,
      trade.entryTimestamp,
      20,
      20,
    );

    return { trade, surroundingCandles };
  }
}
