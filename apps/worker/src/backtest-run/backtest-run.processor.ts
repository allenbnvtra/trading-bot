import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import Decimal from "decimal.js";
import {
  backtestsRepository,
  candlesRepository,
  instrumentsRepository,
  strategiesRepository,
} from "@trading-copilot/database";
import { STRATEGY_REGISTRY, type StrategyKey } from "@trading-copilot/strategy-engine";
import { calculateBacktestMetrics, runBacktest, type StrategyParametersFor } from "@trading-copilot/backtester";
import type { StrategyVersion } from "@trading-copilot/trading-domain";
import { BACKTEST_RUN_QUEUE, type BacktestRunJobPayload } from "./backtest-run.constants";

const WORKER_CONCURRENCY = process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 2;

function isStrategyKey(key: string): key is StrategyKey {
  return Object.hasOwn(STRATEGY_REGISTRY, key);
}

/**
 * Consumes the "backtest-run" queue's "run" jobs. The job payload only ever
 * carries { backtestId } — every other input (instrument, strategy version,
 * candles, assumptions) is re-fetched from Postgres here, so Postgres stays
 * the single source of truth and a retried job can never act on stale data.
 *
 * All backtesting math lives in @trading-copilot/backtester /
 * @trading-copilot/strategy-engine; this processor only orchestrates
 * fetch -> compute -> persist -> status.
 */
@Processor(BACKTEST_RUN_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class BacktestRunProcessor extends WorkerHost {
  private readonly logger = new Logger(BacktestRunProcessor.name);

  async process(job: Job<BacktestRunJobPayload>): Promise<void> {
    const { backtestId } = job.data;

    try {
      await backtestsRepository.markBacktestRunning(backtestId);

      const backtest = await backtestsRepository.getBacktest(backtestId);
      if (!backtest) {
        throw new Error(`Backtest ${backtestId} not found`);
      }

      const [instrument, strategyVersion] = await Promise.all([
        instrumentsRepository.getInstrument(backtest.instrumentId),
        strategiesRepository.getStrategyVersion(backtest.strategyVersionId),
      ]);

      if (!instrument) {
        throw new Error(`Instrument ${backtest.instrumentId} not found`);
      }
      if (!strategyVersion) {
        throw new Error(`Strategy version ${backtest.strategyVersionId} not found`);
      }

      // packages/backtester has no DB access and cannot resolve
      // strategyVersion.strategyId -> Strategy.key itself; resolve it here.
      const strategy = await strategiesRepository.getStrategyWithVersions(strategyVersion.strategyId);
      if (!strategy) {
        throw new Error(`Strategy ${strategyVersion.strategyId} not found`);
      }
      if (!isStrategyKey(strategy.key)) {
        throw new Error(
          `Strategy key "${strategy.key}" is not a known StrategyKey (present in STRATEGY_REGISTRY)`,
        );
      }

      // The database layer stores parameters as untyped JSON (it has no
      // knowledge of which strategy's parameter schema applies); the
      // strategy's own evaluate() re-validates them against its Zod schema
      // at runtime, so this cast is safe. Widened to StrategyParametersFor<StrategyKey>
      // (a union over every registered strategy's parameter shape, not just
      // EmaTrendPullbackParameters) now that runBacktest is generic over any
      // registered StrategyKey.
      const typedStrategyVersion = strategyVersion as unknown as StrategyVersion<
        StrategyParametersFor<StrategyKey>
      >;

      // Candles are fetched over [startDate, endDate]; too few candles to
      // produce signals is handled gracefully by runBacktest/evaluate*
      // (they just produce zero signals), so no redundant guard is added
      // here.
      const candles = await candlesRepository.getCandles(
        backtest.instrumentId,
        backtest.timeframe,
        backtest.startDate,
        backtest.endDate,
      );

      const { assumptions } = backtest;
      const initialBalance = new Decimal(assumptions.initialBalance);

      const result = runBacktest({
        strategyKey: strategy.key,
        instrument,
        candles,
        strategyVersion: typedStrategyVersion,
        initialBalance,
        riskPercentage: new Decimal(assumptions.riskPercentage),
        slippageTicks: assumptions.slippageTicks,
      });

      const metrics = calculateBacktestMetrics(result.trades, initialBalance);

      // replaceBacktestTrades deletes-then-recreates in one transaction, so
      // retrying this job for the same backtestId never produces duplicate
      // trade rows, and a failure partway through step leaves nothing extra
      // behind for the next successful retry to clean up.
      await backtestsRepository.replaceBacktestTrades(backtestId, result.trades);
      await backtestsRepository.upsertBacktestMetrics(backtestId, metrics);

      await backtestsRepository.markBacktestCompleted(backtestId);

      if (result.skippedSignalCount > 0) {
        this.logger.warn(
          `Backtest ${backtestId} skipped ${result.skippedSignalCount} signal(s) whose position size floored to 0`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Backtest ${backtestId} failed: ${message}`);
      await backtestsRepository.markBacktestFailed(backtestId, message);
      throw error;
    }
  }
}
