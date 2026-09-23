import Decimal from "decimal.js";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./client";
import { FinalTestAlreadySpentError, ResearchStageOrderError } from "./errors";
import * as backtestsRepository from "./repositories/backtests";
import * as instrumentsRepository from "./repositories/instruments";
import * as journalTradesRepository from "./repositories/journal-trades";
import * as marketSnapshotsRepository from "./repositories/market-snapshots";
import { researchRepository } from "./repositories/research";
import * as setupsRepository from "./repositories/setups";

/**
 * Research repository, end-to-end against a real Postgres database.
 * Requires DATABASE_URL and the Milestone 1 seed (`pnpm db:seed`) to have
 * been run at least once, since it looks up the seeded GENFUT1 instrument
 * and ema-trend-pullback/1.0.0 strategy version rather than fabricating its
 * own (this project has no seedTestInstrument/seedTestStrategy helper, see
 * journal.integration.test.ts, which every other *.integration.test.ts file
 * in this package mirrors, this one included).
 */
describe.skipIf(!process.env.DATABASE_URL)("researchRepository (live Postgres)", () => {
  let instrumentId: string;
  let strategyId: string;
  let strategyVersionId: string;

  beforeAll(async () => {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
    expect(instrument, "expected the Milestone 1 seed to have run (pnpm db:seed)").not.toBeNull();
    if (!instrument) throw new Error("seeded GENFUT1/SIM-FUT instrument not found");
    instrumentId = instrument.id;

    const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
    expect(strategy).not.toBeNull();
    if (!strategy) throw new Error("seeded ema-trend-pullback strategy not found");
    strategyId = strategy.id;

    const strategyVersion = await prisma.strategyVersion.findUnique({
      where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
    });
    expect(strategyVersion).not.toBeNull();
    if (!strategyVersion) throw new Error("seeded ema-trend-pullback/1.0.0 strategy version not found");
    strategyVersionId = strategyVersion.id;
  });

  it("creates an AgentExecution RUNNING, then marks it SUCCEEDED with outputs", async () => {
    const created = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: { tradeCount: 10 },
    });
    expect(created.status).toBe("RUNNING");

    // The creation-time provider/model/promptVersion is only the API
    // process's guess; the values from the provider that actually ran
    // overwrite it on completion.
    const succeeded = await researchRepository.markAgentExecutionSucceeded(created.id, {
      provider: "ANTHROPIC",
      model: "claude-sonnet-5-20260901",
      promptVersion: "1.0.1",
      outputRaw: '{"title":"x"}',
      outputParsed: { title: "x" },
      tokensInput: 100,
      tokensOutput: 200,
      costUsd: new Decimal("0.001"),
    });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.outputParsed).toEqual({ title: "x" });
    expect(succeeded.provider).toBe("ANTHROPIC");
    expect(succeeded.model).toBe("claude-sonnet-5-20260901");
    expect(succeeded.promptVersion).toBe("1.0.1");
  });

  it("marks an AgentExecution FAILED preserving the raw response, usage, cost, and real model of a billed response", async () => {
    const before = await researchRepository.getTodayResearchSpend();
    const created = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });

    const failed = await researchRepository.markAgentExecutionFailed(created.id, {
      outputRaw: '[{"type":"text","text":"no tool call"}]',
      errorMessage: "response contained no tool_use block",
      tokensInput: 40,
      tokensOutput: 60,
      costUsd: new Decimal("0.0012"),
      provider: "ANTHROPIC",
      model: "claude-sonnet-5-20260901",
      promptVersion: "1.0.0",
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.outputRaw).toBe('[{"type":"text","text":"no tool call"}]');
    expect(failed.tokensInput).toBe(40);
    expect(failed.tokensOutput).toBe(60);
    expect(failed.costUsd?.toString()).toBe("0.0012");
    expect(failed.provider).toBe("ANTHROPIC");
    expect(failed.model).toBe("claude-sonnet-5-20260901");

    // A failed-but-billed call counts toward today's budget.
    const after = await researchRepository.getTodayResearchSpend();
    expect(after.tokensUsed - before.tokensUsed).toBeGreaterThanOrEqual(100);
  });

  it("marks an AgentExecution FAILED with an error message", async () => {
    const created = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });

    const failed = await researchRepository.markAgentExecutionFailed(created.id, {
      outputRaw: null,
      errorMessage: "provider timeout",
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toBe("provider timeout");
    // No response existed, so the creation-time audit fields are untouched
    // and usage stays null.
    expect(failed.provider).toBe("MOCK");
    expect(failed.model).toBe("mock-v1");
    expect(failed.tokensInput).toBeNull();

    const fetched = await researchRepository.getAgentExecution(created.id);
    expect(fetched?.status).toBe("FAILED");

    const all = await researchRepository.listAgentExecutions();
    expect(all.some((execution) => execution.id === created.id)).toBe(true);
  });

  it("rejects a VALIDATION experiment when no COMPLETED RESEARCH experiment exists yet for the hypothesis", async () => {
    const execution = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });
    await researchRepository.markAgentExecutionSucceeded(execution.id, {
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      outputRaw: "{}",
      outputParsed: {},
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: new Decimal(0),
    });
    const hypothesis = await researchRepository.createResearchHypothesis({
      agentExecutionId: execution.id,
      title: "stage order test",
      statement: "s",
      rationale: "r",
      confidence: "MEDIUM",
      sourceDataSummary: {},
      proposedStrategyDefinition: {},
    });

    await expect(
      researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "VALIDATION",
        datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-02-01T00:00:00Z"),
      }),
    ).rejects.toThrow(ResearchStageOrderError);

    const experiments = await researchRepository.listResearchExperimentsForHypothesis(hypothesis.id);
    expect(experiments).toHaveLength(0);
  });

  it("never allows a second non-FAILED FINAL_TEST experiment for the same hypothesis", async () => {
    const execution = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });
    await researchRepository.markAgentExecutionSucceeded(execution.id, {
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      outputRaw: "{}",
      outputParsed: {},
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: new Decimal(0),
    });
    const hypothesis = await researchRepository.createResearchHypothesis({
      agentExecutionId: execution.id,
      title: "t",
      statement: "s",
      rationale: "r",
      confidence: "MEDIUM",
      sourceDataSummary: {},
      proposedStrategyDefinition: {},
    });

    // Stage ordering requires a COMPLETED experiment at each prior stage
    // before the next stage's dataset can be spent, and markResearchExperimentCompleted
    // requires a real Backtest row (ResearchExperiment.backtestId is a genuine
    // foreign key), so each stage below gets its own throwaway Backtest.
    const backtestAssumptions = {
      commissionPerContract: "2.50",
      slippageTicks: 1,
      riskPercentage: "1",
      initialBalance: "10000",
    };

    const researchBacktest = await backtestsRepository.createBacktest({
      strategyVersionId,
      instrumentId,
      timeframe: "1h",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-04-01T00:00:00Z"),
      assumptions: backtestAssumptions,
    });
    const researchExperiment = await researchRepository.createResearchExperiment({
      hypothesisId: hypothesis.id,
      datasetRole: "RESEARCH",
      datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-04-01T00:00:00Z"),
    });
    await researchRepository.markResearchExperimentCompleted(researchExperiment.id, researchBacktest.id);

    const validationBacktest = await backtestsRepository.createBacktest({
      strategyVersionId,
      instrumentId,
      timeframe: "1h",
      startDate: new Date("2026-04-01T00:00:00Z"),
      endDate: new Date("2026-05-01T00:00:00Z"),
      assumptions: backtestAssumptions,
    });
    const validationExperiment = await researchRepository.createResearchExperiment({
      hypothesisId: hypothesis.id,
      datasetRole: "VALIDATION",
      datasetWindowStart: new Date("2026-04-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-05-01T00:00:00Z"),
    });
    await researchRepository.markResearchExperimentCompleted(validationExperiment.id, validationBacktest.id);

    await researchRepository.createResearchExperiment({
      hypothesisId: hypothesis.id,
      datasetRole: "FINAL_TEST",
      datasetWindowStart: new Date("2026-05-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-06-01T00:00:00Z"),
    });

    await expect(
      researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "FINAL_TEST",
        datasetWindowStart: new Date("2026-06-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-07-01T00:00:00Z"),
      }),
    ).rejects.toThrow(FinalTestAlreadySpentError);
  });

  it("never physically deletes a FAILED experiment or AgentExecution: no delete function exists on the repository", () => {
    expect((researchRepository as Record<string, unknown>).deleteResearchExperiment).toBeUndefined();
    expect((researchRepository as Record<string, unknown>).deleteAgentExecution).toBeUndefined();
  });

  it("lists enriched journal trades with MarketSnapshot context for a setup-backed trade and null context otherwise", async () => {
    // Fixed, far-future window unused by any other seed/test data in this
    // package so this query only ever matches rows this test itself wrote.
    const windowStart = new Date("2099-01-01T00:00:00.000Z");
    const windowEnd = new Date("2099-02-01T00:00:00.000Z");

    const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId,
      timestamp: new Date("2099-01-05T08:00:00.000Z"),
      timeframe: "1h",
      trend1h: "UP",
      session: "RTH",
      timeOfDay: "MORNING",
      marketRegime: "TRENDING",
      vwapDistance: new Decimal("1.5"),
      volumePercentile: new Decimal("60"),
      atrPercentile: new Decimal("40"),
      metadata: { researchIntegrationTest: true },
    });

    const plannedEntry = new Decimal("5200");
    const plannedStop = new Decimal("5185");
    const plannedTarget1 = new Decimal("5230");

    const setup = await setupsRepository.createSetup({
      instrumentId,
      strategyId,
      strategyVersionId,
      marketSnapshotId: snapshot.id,
      direction: "LONG",
      source: "MANUAL_TEST",
      plannedEntry,
      plannedStop,
      plannedTarget1,
      metadata: { researchIntegrationTest: true },
    });

    let setupBackedTrade = await journalTradesRepository.createJournalTrade({
      setupId: setup.id,
      instrumentId,
      strategyId,
      strategyVersionId,
      direction: "LONG",
      plannedEntry,
      plannedStop,
      plannedTarget1,
      plannedRisk: new Decimal("150"),
      executionMode: "PAPER",
    });
    setupBackedTrade = await journalTradesRepository.recordJournalTradeEntry(setupBackedTrade.id, {
      actualEntry: new Decimal("5200.25"),
      entryTimestamp: new Date("2099-01-05T09:00:00.000Z"),
      quantity: 2,
      estimatedFees: new Decimal("5"),
      estimatedSlippage: new Decimal("1"),
    });
    setupBackedTrade = await journalTradesRepository.closeJournalTrade(setupBackedTrade.id, {
      actualExit: new Decimal("5229.75"),
      exitTimestamp: new Date("2099-01-05T15:00:00.000Z"),
      actualFees: new Decimal("5"),
      actualSlippage: new Decimal("1"),
    });

    let manualTrade = await journalTradesRepository.createJournalTrade({
      instrumentId,
      strategyId,
      strategyVersionId,
      direction: "SHORT",
      plannedEntry: new Decimal("5300"),
      plannedStop: new Decimal("5315"),
      executionMode: "MANUAL_LIVE",
    });
    manualTrade = await journalTradesRepository.recordJournalTradeEntry(manualTrade.id, {
      actualEntry: new Decimal("5300"),
      entryTimestamp: new Date("2099-01-10T09:00:00.000Z"),
      quantity: 1,
      estimatedFees: new Decimal("2.5"),
      estimatedSlippage: null,
    });
    manualTrade = await journalTradesRepository.closeJournalTrade(manualTrade.id, {
      actualExit: new Decimal("5290"),
      exitTimestamp: new Date("2099-01-10T15:00:00.000Z"),
      actualFees: new Decimal("2.5"),
      actualSlippage: null,
    });

    const enriched = await researchRepository.listEnrichedJournalTradesForResearch({
      strategyId,
      instrumentId,
      windowStart,
      windowEnd,
    });

    // Looked up by id, not by array position/length: this fixed 2099 window
    // is deterministic across test runs, so a prior run against the same
    // long-lived dev database can leave earlier rows behind. Matching by id
    // keeps this test correct regardless of what else already lives in that
    // window.
    const setupBackedResult = enriched.find((trade) => trade.id === setupBackedTrade.id);
    const manualResult = enriched.find((trade) => trade.id === manualTrade.id);

    expect(setupBackedResult).toBeDefined();
    expect(setupBackedResult!.source).toBe("JOURNAL");
    expect(setupBackedResult!.context).not.toBeNull();
    expect(setupBackedResult!.context?.session).toBe("RTH");
    expect(setupBackedResult!.context?.timeOfDay).toBe("MORNING");
    expect(setupBackedResult!.context?.marketRegime).toBe("TRENDING");
    expect(setupBackedResult!.context?.vwapDistance?.toString()).toBe("1.5");
    expect(setupBackedResult!.context?.volumePercentile?.toString()).toBe("60");
    expect(setupBackedResult!.context?.atrPercentile?.toString()).toBe("40");
    expect(setupBackedResult!.entryPrice.toString()).toBe("5200.25");
    expect(setupBackedResult!.exitPrice.toString()).toBe("5229.75");

    expect(manualResult).toBeDefined();
    expect(manualResult!.context).toBeNull();
  });

  it("sums today's AgentExecution token/cost spend", async () => {
    const before = await researchRepository.getTodayResearchSpend();

    const execution = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });
    await researchRepository.markAgentExecutionSucceeded(execution.id, {
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      outputRaw: "{}",
      outputParsed: {},
      tokensInput: 50,
      tokensOutput: 75,
      costUsd: new Decimal("0.02"),
    });

    const after = await researchRepository.getTodayResearchSpend();
    expect(after.tokensUsed).toBe(before.tokensUsed + 125);
    expect(after.costUsd.minus(before.costUsd).toString()).toBe("0.02");
  });
});
