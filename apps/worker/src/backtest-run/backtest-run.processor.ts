import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import Decimal from "decimal.js";
import {
  backtestsRepository,
  candlesRepository,
  instrumentsRepository,
  researchRepository,
  strategiesRepository,
} from "@trading-copilot/database";
import { STRATEGY_VERSION_STATUS_FOR_COMPLETED_DATASET_ROLE } from "@trading-copilot/shared-types";
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
 *
 * Milestone 7: the same processor also runs every ResearchExperiment's
 * Backtest (ResearchService.createExperiment enqueues onto this queue; no
 * duplicated backtest logic). A research-originated Backtest has exactly
 * one ResearchExperiment (ResearchExperiment.backtestId is unique); a plain
 * POST /backtests Backtest has none, and for it the research hooks below are
 * one null getResearchExperimentByBacktestId lookup per hook point (success,
 * or failure) and nothing else. Every research status transition is an
 * atomic conditional update in the repository (a retried job can never
 * double-complete, un-fail, or relabel a COMPLETED experiment FAILED).
 */
@Processor(BACKTEST_RUN_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class BacktestRunProcessor extends WorkerHost {
  private readonly logger = new Logger(BacktestRunProcessor.name);

  async process(job: Job<BacktestRunJobPayload>): Promise<void> {
    const { backtestId } = job.data;

    try {
      await backtestsRepository.markBacktestRunning(backtestId);
      await this.markResearchExperimentRunning(backtestId);

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
      await this.failResearchExperiment(backtestId, message);
      throw error;
    }

    // Deliberately outside the try above: the Backtest itself is already
    // durably COMPLETED at this point, so an error while recording the
    // research side must not relabel a genuinely completed Backtest FAILED.
    // It still fails the job (rethrown), so the problem is visible, and
    // every step below is idempotent for a re-run.
    await this.completeResearchExperiment(backtestId);
  }

  private async markResearchExperimentRunning(backtestId: string): Promise<void> {
    const experiment = await researchRepository.getResearchExperimentByBacktestId(backtestId);
    if (experiment) {
      await researchRepository.markResearchExperimentRunning(experiment.id);
    }
  }

  /**
   * Marks the experiment COMPLETED (its RESEARCH_EXPERIMENT_COMPLETED
   * journal event is written in the same transaction by the repository) and
   * advances its StrategyVersion per
   * STRATEGY_VERSION_STATUS_FOR_COMPLETED_DATASET_ROLE. The advance runs
   * whenever the experiment is COMPLETED after this call, including when a
   * previous attempt already completed it, so a job that died between the
   * two steps heals on re-run; advanceStrategyVersionStatus is monotonic
   * and a no-op once the status is already there.
   */
  private async completeResearchExperiment(backtestId: string): Promise<void> {
    const experiment = await researchRepository.getResearchExperimentByBacktestId(backtestId);
    if (!experiment) {
      return;
    }

    const completed =
      (await researchRepository.markResearchExperimentCompleted(experiment.id, backtestId)) ??
      (await researchRepository.getResearchExperimentByBacktestId(backtestId));
    if (!completed || completed.status !== "COMPLETED") {
      this.logger.warn(
        `ResearchExperiment ${experiment.id} for Backtest ${backtestId} is ${completed?.status ?? "missing"}, ` +
          "not COMPLETED; leaving its StrategyVersion status unchanged",
      );
      return;
    }

    const backtest = await backtestsRepository.getBacktest(backtestId);
    if (!backtest) {
      throw new Error(`Backtest ${backtestId} not found while advancing its research StrategyVersion`);
    }
    await strategiesRepository.advanceStrategyVersionStatus(
      backtest.strategyVersionId,
      STRATEGY_VERSION_STATUS_FOR_COMPLETED_DATASET_ROLE[completed.datasetRole],
      { researchExperimentId: completed.id },
    );
  }

  /**
   * Marks the experiment FAILED (RESEARCH_EXPERIMENT_FAILED journal event in
   * the same transaction). Never advances the StrategyVersion. Errors here
   * are logged, not thrown, so the original backtest error is what the
   * caller rethrows. BACKTEST_RUN_QUEUE uses BullMQ's default attempts: 1,
   * so a failed run is terminal and FAILED is the experiment's final state;
   * a human re-runs the stage via a fresh experiment (failed experiments
   * are kept, never deleted, per docs/research-methodology.md).
   */
  private async failResearchExperiment(backtestId: string, message: string): Promise<void> {
    try {
      const experiment = await researchRepository.getResearchExperimentByBacktestId(backtestId);
      if (experiment) {
        await researchRepository.markResearchExperimentFailed(experiment.id, message);
      }
    } catch (researchError) {
      const detail = researchError instanceof Error ? researchError.message : String(researchError);
      this.logger.error(`Could not mark the ResearchExperiment for Backtest ${backtestId} FAILED: ${detail}`);
    }
  }
}
