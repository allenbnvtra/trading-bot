import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResearchHypothesis } from "@trading-copilot/trading-domain";
import { prisma } from "./client";
import { FinalTestAlreadySpentError, ResearchStageOrderError } from "./errors";
import * as backtestsRepository from "./repositories/backtests";
import type { CreateBacktestInput } from "./repositories/backtests";
import * as instrumentsRepository from "./repositories/instruments";
import { researchRepository } from "./repositories/research";
import * as strategiesRepository from "./repositories/strategies";

/**
 * Milestone 7 fix wave 1, end-to-end against a real Postgres database:
 * window isolation between stages, the holdout-date guard, the
 * transactional Backtest+experiment create, atomic experiment lifecycle
 * transitions (a COMPLETED experiment can never be relabeled FAILED), and
 * the monotonic StrategyVersion status advance. Same prerequisites as
 * research.integration.test.ts (DATABASE_URL, `pnpm db:seed`, migrations
 * applied).
 *
 * Every hypothesis here is created fresh per test, so these tests never
 * depend on rows a previous run left behind in the long-lived dev database.
 */
describe.skipIf(!process.env.DATABASE_URL)("research pipeline hardening (live Postgres)", () => {
  let instrumentId: string;
  let strategyVersionId: string;
  let testStrategyId: string;

  const assumptions = {
    commissionPerContract: "2.50",
    slippageTicks: 1,
    riskPercentage: "1",
    initialBalance: "10000",
  };

  beforeAll(async () => {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
    if (!instrument) throw new Error("seeded GENFUT1/SIM-FUT instrument not found (run pnpm db:seed)");
    instrumentId = instrument.id;

    const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
    if (!strategy) throw new Error("seeded ema-trend-pullback strategy not found");
    const strategyVersion = await prisma.strategyVersion.findUnique({
      where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
    });
    if (!strategyVersion) throw new Error("seeded ema-trend-pullback/1.0.0 strategy version not found");
    strategyVersionId = strategyVersion.id;

    // A dedicated container Strategy for the throwaway StrategyVersions the
    // status-advance tests create, so they never add versions to the seeded
    // ema-trend-pullback strategy.
    const key = "integration-test-status-advance";
    const existing = await strategiesRepository.getStrategyByKey(key);
    testStrategyId = (
      existing ??
      (await strategiesRepository.createStrategy({
        key,
        name: "Integration test: status advance",
        description: "Throwaway versions created by research-pipeline.integration.test.ts",
      }))
    ).id;
  });

  async function createHypothesis(sourceDataSummary: Record<string, unknown> = {}): Promise<ResearchHypothesis> {
    const execution = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });
    await researchRepository.markAgentExecutionSucceeded(execution.id, {
      outputRaw: "{}",
      outputParsed: {},
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: new Decimal(0),
    });
    return researchRepository.createResearchHypothesis({
      agentExecutionId: execution.id,
      title: "fix wave 1 integration test",
      statement: "s",
      rationale: "r",
      confidence: "MEDIUM",
      sourceDataSummary,
      proposedStrategyDefinition: {},
    });
  }

  function backtestFor(start: string, end: string): CreateBacktestInput {
    return {
      strategyVersionId,
      instrumentId,
      timeframe: "1h",
      startDate: new Date(start),
      endDate: new Date(end),
      assumptions,
    };
  }

  /** Creates (with its Backtest) and completes one experiment. */
  async function completeStage(
    hypothesisId: string,
    datasetRole: "RESEARCH" | "VALIDATION" | "FINAL_TEST" | "WALK_FORWARD",
    start: string,
    end: string,
  ) {
    const experiment = await researchRepository.createResearchExperiment({
      hypothesisId,
      datasetRole,
      datasetWindowStart: new Date(start),
      datasetWindowEnd: new Date(end),
      backtest: backtestFor(start, end),
    });
    const completed = await researchRepository.markResearchExperimentCompleted(experiment.id, experiment.backtestId!);
    expect(completed?.status).toBe("COMPLETED");
    return experiment;
  }

  describe("createResearchExperiment", () => {
    it("creates the Backtest and the experiment together, linked, and findable by backtestId", async () => {
      const hypothesis = await createHypothesis();
      const experiment = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "RESEARCH",
        datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-02-01T00:00:00Z"),
        backtest: backtestFor("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      });

      expect(experiment.backtestId).not.toBeNull();
      const backtest = await backtestsRepository.getBacktest(experiment.backtestId!);
      expect(backtest?.status).toBe("QUEUED");

      const found = await researchRepository.getResearchExperimentByBacktestId(experiment.backtestId!);
      expect(found?.id).toBe(experiment.id);
    });

    it("returns null from getResearchExperimentByBacktestId for a plain (non-research) Backtest", async () => {
      const plain = await backtestsRepository.createBacktest(backtestFor("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"));
      expect(await researchRepository.getResearchExperimentByBacktestId(plain.id)).toBeNull();
    });

    it("leaves no orphan Backtest behind when a stage-order precondition rejects the experiment", async () => {
      const hypothesis = await createHypothesis();
      // A unique window no other test uses, so the count is exact.
      const marker = new Date(Date.UTC(2090, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000);
      const markerEnd = new Date(marker.getTime() + 86_400_000);
      const before = await prisma.backtest.count({ where: { startDate: marker } });

      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "VALIDATION",
          datasetWindowStart: marker,
          datasetWindowEnd: markerEnd,
          backtest: { ...backtestFor(marker.toISOString(), markerEnd.toISOString()) },
        }),
      ).rejects.toThrow(ResearchStageOrderError);

      expect(await prisma.backtest.count({ where: { startDate: marker } })).toBe(before);
    });

    it("leaves no orphan Backtest behind when the final-test reuse index rejects the experiment", async () => {
      const hypothesis = await createHypothesis();
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      await completeStage(hypothesis.id, "VALIDATION", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
      await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "FINAL_TEST",
        datasetWindowStart: new Date("2026-03-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-04-01T00:00:00Z"),
        backtest: backtestFor("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
      });

      const marker = new Date(Date.UTC(2091, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000);
      const markerEnd = new Date(marker.getTime() + 86_400_000);
      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "FINAL_TEST",
          datasetWindowStart: marker,
          datasetWindowEnd: markerEnd,
          backtest: backtestFor(marker.toISOString(), markerEnd.toISOString()),
        }),
      ).rejects.toThrow(FinalTestAlreadySpentError);

      expect(await prisma.backtest.count({ where: { startDate: marker } })).toBe(0);
    });

    it("rejects an inverted dataset window", async () => {
      const hypothesis = await createHypothesis();
      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "RESEARCH",
          datasetWindowStart: new Date("2026-02-01T00:00:00Z"),
          datasetWindowEnd: new Date("2026-01-01T00:00:00Z"),
        }),
      ).rejects.toThrow(/datasetWindowEnd must be after datasetWindowStart/);
    });
  });

  describe("dataset-window isolation between stages", () => {
    it("rejects a VALIDATION window that overlaps the RESEARCH window, accepts one starting at its end", async () => {
      const hypothesis = await createHypothesis();
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z");

      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "VALIDATION",
          datasetWindowStart: new Date("2026-03-01T00:00:00Z"),
          datasetWindowEnd: new Date("2026-05-01T00:00:00Z"),
        }),
      ).rejects.toThrow(/must not overlap an earlier stage/);

      const accepted = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "VALIDATION",
        datasetWindowStart: new Date("2026-04-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-05-01T00:00:00Z"),
      });
      expect(accepted.status).toBe("QUEUED");
    });

    it("checks against every earlier non-FAILED stage, not just the immediately-prior role", async () => {
      const hypothesis = await createHypothesis();
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      // A still-QUEUED second VALIDATION attempt reaching further out also
      // counts: its window is already committed to this hypothesis.
      await completeStage(hypothesis.id, "VALIDATION", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
      await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "VALIDATION",
        datasetWindowStart: new Date("2026-03-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-06-01T00:00:00Z"),
      });

      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "FINAL_TEST",
          datasetWindowStart: new Date("2026-04-01T00:00:00Z"),
          datasetWindowEnd: new Date("2026-07-01T00:00:00Z"),
        }),
      ).rejects.toThrow(/must not overlap an earlier stage/);
    });

    it("ignores FAILED experiments' windows", async () => {
      const hypothesis = await createHypothesis();
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      const failedAttempt = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "VALIDATION",
        datasetWindowStart: new Date("2026-02-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-06-01T00:00:00Z"),
      });
      await researchRepository.markResearchExperimentFailed(failedAttempt.id, "backtest crashed");

      const retry = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "VALIDATION",
        datasetWindowStart: new Date("2026-02-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-03-01T00:00:00Z"),
      });
      expect(retry.status).toBe("QUEUED");
    });
  });

  describe("holdout-date guard", () => {
    it("rejects a FINAL_TEST window starting before the hypothesis's sourceDataSummary.sampleWindowEnd", async () => {
      const hypothesis = await createHypothesis({ sampleWindowEnd: "2026-06-15T00:00:00.000Z" });
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      await completeStage(hypothesis.id, "VALIDATION", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");

      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "FINAL_TEST",
          datasetWindowStart: new Date("2026-06-01T00:00:00Z"),
          datasetWindowEnd: new Date("2026-07-01T00:00:00Z"),
        }),
      ).rejects.toThrow(/out-of-sample relative to the data that generated this hypothesis/);

      const accepted = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "FINAL_TEST",
        datasetWindowStart: new Date("2026-06-15T00:00:00Z"),
        datasetWindowEnd: new Date("2026-07-15T00:00:00Z"),
      });
      expect(accepted.status).toBe("QUEUED");
    });

    it("does not apply to VALIDATION (only FINAL_TEST/WALK_FORWARD are holdout-guarded)", async () => {
      const hypothesis = await createHypothesis({ sampleWindowEnd: "2026-06-15T00:00:00.000Z" });
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      const validation = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "VALIDATION",
        datasetWindowStart: new Date("2026-02-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-03-01T00:00:00Z"),
      });
      expect(validation.status).toBe("QUEUED");
    });

    it("is skipped when sampleWindowEnd is null (a zero-trade hypothesis)", async () => {
      const hypothesis = await createHypothesis({ sampleWindowStart: null, sampleWindowEnd: null });
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      await completeStage(hypothesis.id, "VALIDATION", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
      const finalTest = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "FINAL_TEST",
        datasetWindowStart: new Date("2026-03-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-04-01T00:00:00Z"),
      });
      expect(finalTest.status).toBe("QUEUED");
    });

    it("fails closed on an unparseable sampleWindowEnd", async () => {
      const hypothesis = await createHypothesis({ sampleWindowEnd: "not-a-date" });
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      await completeStage(hypothesis.id, "VALIDATION", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "FINAL_TEST",
          datasetWindowStart: new Date("2026-03-01T00:00:00Z"),
          datasetWindowEnd: new Date("2026-04-01T00:00:00Z"),
        }),
      ).rejects.toThrow(/not a valid ISO date/);
    });
  });

  describe("atomic experiment lifecycle", () => {
    it("never relabels a COMPLETED experiment FAILED, so a spent FINAL_TEST stays spent", async () => {
      const hypothesis = await createHypothesis();
      await completeStage(hypothesis.id, "RESEARCH", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      await completeStage(hypothesis.id, "VALIDATION", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
      const finalTest = await completeStage(hypothesis.id, "FINAL_TEST", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z");

      expect(await researchRepository.markResearchExperimentFailed(finalTest.id, "relabel attempt")).toBeNull();

      const [row] = (await researchRepository.listResearchExperimentsForHypothesis(hypothesis.id)).filter(
        (e) => e.id === finalTest.id,
      );
      expect(row?.status).toBe("COMPLETED");
      expect(row?.failureReason).toBeNull();

      // The final-test partial unique index still counts it as spent.
      await expect(
        researchRepository.createResearchExperiment({
          hypothesisId: hypothesis.id,
          datasetRole: "FINAL_TEST",
          datasetWindowStart: new Date("2026-04-01T00:00:00Z"),
          datasetWindowEnd: new Date("2026-05-01T00:00:00Z"),
        }),
      ).rejects.toThrow(FinalTestAlreadySpentError);
    });

    it("lets exactly one of a concurrent complete/fail pair win, and never double-completes", async () => {
      const hypothesis = await createHypothesis();
      const experiment = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "RESEARCH",
        datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-02-01T00:00:00Z"),
        backtest: backtestFor("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      });

      const [completed, failed] = await Promise.all([
        researchRepository.markResearchExperimentCompleted(experiment.id, experiment.backtestId!),
        researchRepository.markResearchExperimentFailed(experiment.id, "race"),
      ]);
      expect([completed, failed].filter((result) => result !== null)).toHaveLength(1);

      // A retried completion is a no-op, not a second transition.
      expect(await researchRepository.markResearchExperimentCompleted(experiment.id, experiment.backtestId!)).toBeNull();

      const events = await prisma.journalEvent.findMany({
        where: {
          entityType: "RESEARCH_EXPERIMENT",
          entityId: experiment.id,
          eventType: { in: ["RESEARCH_EXPERIMENT_COMPLETED", "RESEARCH_EXPERIMENT_FAILED"] },
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe(completed ? "RESEARCH_EXPERIMENT_COMPLETED" : "RESEARCH_EXPERIMENT_FAILED");
    });

    it("records a RESEARCH_EXPERIMENT_FAILED journal event with the failure reason", async () => {
      const hypothesis = await createHypothesis();
      const experiment = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "RESEARCH",
        datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-02-01T00:00:00Z"),
        backtest: backtestFor("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      });
      expect((await researchRepository.markResearchExperimentRunning(experiment.id))?.status).toBe("RUNNING");
      expect(await researchRepository.markResearchExperimentRunning(experiment.id)).toBeNull();

      const failed = await researchRepository.markResearchExperimentFailed(experiment.id, "Instrument missing");
      expect(failed?.status).toBe("FAILED");
      expect(failed?.failureReason).toBe("Instrument missing");

      const event = await prisma.journalEvent.findFirst({
        where: { entityId: experiment.id, eventType: "RESEARCH_EXPERIMENT_FAILED" },
      });
      expect(event).not.toBeNull();
      expect(event!.strategyVersionId).toBe(strategyVersionId);
      expect(event!.metadata).toMatchObject({ failureReason: "Instrument missing", datasetRole: "RESEARCH" });
    });
  });

  describe("schema hardening", () => {
    it("refuses to delete a hypothesis that has experiments (ON DELETE RESTRICT)", async () => {
      const hypothesis = await createHypothesis();
      await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "RESEARCH",
        datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-02-01T00:00:00Z"),
      });
      await expect(prisma.researchHypothesis.delete({ where: { id: hypothesis.id } })).rejects.toThrow();
      expect(await researchRepository.getResearchHypothesis(hypothesis.id)).not.toBeNull();
    });

    it("refuses to delete a backtest that an experiment references (ON DELETE RESTRICT)", async () => {
      const hypothesis = await createHypothesis();
      const experiment = await researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "RESEARCH",
        datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-02-01T00:00:00Z"),
        backtest: backtestFor("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      });
      await expect(prisma.backtest.delete({ where: { id: experiment.backtestId! } })).rejects.toThrow();
      expect(await backtestsRepository.getBacktest(experiment.backtestId!)).not.toBeNull();
    });
  });

  describe("advanceStrategyVersionStatus", () => {
    async function createVersion() {
      return strategiesRepository.createStrategyVersion({
        strategyId: testStrategyId,
        version: `advance-${randomUUID()}`,
        name: "advance test",
        description: "",
        parameters: {},
        status: "DISCOVERED",
      });
    }

    it("advances forward, is idempotent, and never regresses", async () => {
      const version = await createVersion();

      const advanced = await strategiesRepository.advanceStrategyVersionStatus(version.id, "VALIDATION", {
        researchExperimentId: "experiment-x",
      });
      expect(advanced?.status).toBe("VALIDATION");

      expect(await strategiesRepository.advanceStrategyVersionStatus(version.id, "VALIDATION")).toBeNull();
      expect(await strategiesRepository.advanceStrategyVersionStatus(version.id, "BACKTESTING")).toBeNull();
      expect((await strategiesRepository.getStrategyVersion(version.id))?.status).toBe("VALIDATION");

      const events = await prisma.journalEvent.findMany({
        where: { entityId: version.id, eventType: "STRATEGY_VERSION_STATUS_CHANGED" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({
        from: "DISCOVERED",
        to: "VALIDATION",
        researchExperimentId: "experiment-x",
      });
    });

    it("reaches WALK_FORWARD, which is what makes markPaperCandidate reachable", async () => {
      const version = await createVersion();
      await strategiesRepository.advanceStrategyVersionStatus(version.id, "WALK_FORWARD");
      expect((await strategiesRepository.markPaperCandidate(version.id))?.status).toBe("PAPER_CANDIDATE");
      // And an automatic advance never drags a human-promoted version back.
      expect(await strategiesRepository.advanceStrategyVersionStatus(version.id, "WALK_FORWARD")).toBeNull();
      expect((await strategiesRepository.getStrategyVersion(version.id))?.status).toBe("PAPER_CANDIDATE");
    });

    it("refuses to automatically advance to a human-gated status", async () => {
      const version = await createVersion();
      await expect(strategiesRepository.advanceStrategyVersionStatus(version.id, "PAPER_CANDIDATE")).rejects.toThrow(
        /human-gated/,
      );
      expect((await strategiesRepository.getStrategyVersion(version.id))?.status).toBe("DISCOVERED");
    });

    it("lets exactly one of two concurrent identical advances win", async () => {
      const version = await createVersion();
      const results = await Promise.all([
        strategiesRepository.advanceStrategyVersionStatus(version.id, "OUT_OF_SAMPLE"),
        strategiesRepository.advanceStrategyVersionStatus(version.id, "OUT_OF_SAMPLE"),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect((await strategiesRepository.getStrategyVersion(version.id))?.status).toBe("OUT_OF_SAMPLE");
    });
  });
});
