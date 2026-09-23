import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { ResearchBudgetExceededError, ResearchStageOrderError } from "@trading-copilot/database";
import type { EnrichedJournalTrade } from "@trading-copilot/analytics";
import type { ResearchExperiment, StrategyVersion } from "@trading-copilot/trading-domain";
import { ResearchService } from "./research.service";

const { researchRepository, strategiesRepository, journalEventsRepository, instrumentsRepository } = vi.hoisted(() => ({
  journalEventsRepository: {
    createJournalEvent: vi.fn(),
  },
  instrumentsRepository: {
    getInstrument: vi.fn(),
  },
  researchRepository: {
    getTodayResearchSpend: vi.fn(),
    createAgentExecution: vi.fn(),
    listEnrichedJournalTradesForResearch: vi.fn(),
    listResearchHypotheses: vi.fn(),
    getResearchHypothesis: vi.fn(),
    listResearchExperimentsForHypothesis: vi.fn(),
    getAgentExecution: vi.fn(),
    createResearchExperiment: vi.fn(),
    assertResearchExperimentPreconditions: vi.fn(),
  },
  strategiesRepository: {
    findStrategyVersionBySourceHypothesis: vi.fn(),
    getStrategyByKey: vi.fn(),
    createStrategy: vi.fn(),
    createStrategyVersion: vi.fn(),
    markPaperCandidate: vi.fn(),
  },
}));

// Mirrors analytics.service.test.ts's/backtest.service.test.ts's convention
// exactly: mock only the pieces this test cares about via vi.importActual,
// rather than the brief's illustrative constructor-injected repository mock.
// This codebase's real DI convention (confirmed by reading
// setup.service.ts/backtest.service.ts) is that repositories are plain
// module-level imports, never constructor parameters.
vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>("@trading-copilot/database");
  return {
    ...actual,
    researchRepository,
    strategiesRepository,
    journalEventsRepository,
    instrumentsRepository,
  };
});

const RESEARCH_DAILY_TOKEN_BUDGET_ENV = "RESEARCH_DAILY_TOKEN_BUDGET";

describe("ResearchService.generateHypothesis", () => {
  let queueAdd: ReturnType<typeof vi.fn>;
  let service: ResearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    queueAdd = vi.fn().mockResolvedValue(undefined);
    service = new ResearchService({ add: queueAdd } as never, { add: vi.fn() } as never);
  });

  it("throws ResearchBudgetExceededError when today's token spend already meets the configured budget", async () => {
    process.env[RESEARCH_DAILY_TOKEN_BUDGET_ENV] = "1000";
    researchRepository.getTodayResearchSpend.mockResolvedValue({ tokensUsed: 1000, costUsd: new Decimal(0) });

    await expect(service.generateHypothesis({})).rejects.toThrow(ResearchBudgetExceededError);
    expect(researchRepository.createAgentExecution).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();

    delete process.env[RESEARCH_DAILY_TOKEN_BUDGET_ENV];
  });
});

function makeExperiment(overrides: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id: overrides.id ?? "experiment-1",
    hypothesisId: "hypothesis-1",
    datasetRole: "FINAL_TEST",
    datasetWindowStart: new Date("2026-01-01T00:00:00.000Z"),
    datasetWindowEnd: new Date("2026-03-01T00:00:00.000Z"),
    backtestId: "backtest-1",
    status: "COMPLETED",
    failureReason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeStrategyVersion(overrides: Partial<StrategyVersion> = {}): StrategyVersion {
  return {
    id: "strategy-version-1",
    strategyId: "strategy-1",
    version: "hypothesis-1",
    name: "AI hypothesis",
    description: "",
    parameters: {},
    status: "WALK_FORWARD",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    sourceHypothesisId: "hypothesis-1",
    ...overrides,
  };
}

function makeTrade(overrides: Partial<EnrichedJournalTrade> = {}): EnrichedJournalTrade {
  return {
    source: "JOURNAL",
    id: overrides.id ?? "trade",
    strategyId: "strategy-1",
    strategyVersionId: "strategy-version-1",
    instrumentId: "instrument-1",
    direction: "LONG",
    executionMode: "MANUAL_LIVE",
    entryTimestamp: new Date("2026-01-01T00:00:00.000Z"),
    exitTimestamp: new Date("2026-01-01T01:00:00.000Z"),
    entryPrice: new Decimal(100),
    exitPrice: new Decimal(101),
    quantity: 1,
    grossPnl: new Decimal(100),
    fees: new Decimal(4),
    netPnl: new Decimal(96),
    riskAmount: new Decimal(50),
    rMultiple: new Decimal(1.92),
    mfe: new Decimal(2),
    mae: new Decimal(0.5),
    slippage: null,
    context: null,
    ...overrides,
  };
}

/** Enough trades, spread across enough calendar days, to satisfy assertSampleSizeGuardrails (MINIMUM_CANDIDATE_SETUPS=100, MINIMUM_CALENDAR_DAYS=60). */
function makeMatureTradeSet(): EnrichedJournalTrade[] {
  return Array.from({ length: 130 }, (_, i) => {
    const dayOffset = Math.floor(i / 2);
    return makeTrade({
      id: `trade-${i}`,
      entryTimestamp: new Date(Date.UTC(2026, 0, 1 + dayOffset)),
      exitTimestamp: new Date(Date.UTC(2026, 0, 1 + dayOffset, 1)),
    });
  });
}

const RESEARCH_EXPERIMENT_INPUT = {
  datasetRole: "RESEARCH",
  instrumentId: "instrument-1",
  timeframe: "5m",
  datasetWindowStart: "2025-11-01T00:00:00.000Z",
  datasetWindowEnd: "2025-12-01T00:00:00.000Z",
  slippageTicks: 1,
  riskPercentage: "1",
  initialBalance: "100000",
} as const;

describe("ResearchService.createExperiment", () => {
  let service: ResearchService;
  let backtestQueueAdd: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    backtestQueueAdd = vi.fn().mockResolvedValue(undefined);
    service = new ResearchService({ add: vi.fn() } as never, { add: backtestQueueAdd } as never);
    researchRepository.assertResearchExperimentPreconditions.mockResolvedValue(undefined);
  });

  it("records a RESEARCH_EXPERIMENT_CREATED journal event for the persisted experiment", async () => {
    researchRepository.getResearchHypothesis.mockResolvedValue({ id: "hypothesis-1" });
    instrumentsRepository.getInstrument.mockResolvedValue({ commissionPerContract: new Decimal("2.5") });
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(makeStrategyVersion());
    researchRepository.createResearchExperiment.mockResolvedValue(
      makeExperiment({ id: "experiment-new", datasetRole: "RESEARCH", status: "QUEUED", completedAt: null }),
    );

    const experiment = await service.createExperiment("hypothesis-1", RESEARCH_EXPERIMENT_INPUT as never);

    expect(experiment.id).toBe("experiment-new");
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledTimes(1);
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "RESEARCH_EXPERIMENT_CREATED",
        entityType: "RESEARCH_EXPERIMENT",
        entityId: "experiment-new",
        strategyVersionId: "strategy-version-1",
        metadata: expect.objectContaining({ hypothesisId: "hypothesis-1", datasetRole: "RESEARCH", backtestId: "backtest-1" }),
      }),
    );
  });

  it("creates the Backtest inside createResearchExperiment and enqueues it onto BACKTEST_RUN_QUEUE", async () => {
    researchRepository.getResearchHypothesis.mockResolvedValue({ id: "hypothesis-1" });
    instrumentsRepository.getInstrument.mockResolvedValue({ commissionPerContract: new Decimal("2.5") });
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(makeStrategyVersion());
    researchRepository.createResearchExperiment.mockResolvedValue(
      makeExperiment({ id: "experiment-new", datasetRole: "RESEARCH", status: "QUEUED", backtestId: "backtest-9" }),
    );

    await service.createExperiment("hypothesis-1", RESEARCH_EXPERIMENT_INPUT as never);

    expect(researchRepository.createResearchExperiment).toHaveBeenCalledWith({
      hypothesisId: "hypothesis-1",
      datasetRole: "RESEARCH",
      datasetWindowStart: new Date("2025-11-01T00:00:00.000Z"),
      datasetWindowEnd: new Date("2025-12-01T00:00:00.000Z"),
      backtest: {
        strategyVersionId: "strategy-version-1",
        instrumentId: "instrument-1",
        timeframe: "5m",
        startDate: new Date("2025-11-01T00:00:00.000Z"),
        endDate: new Date("2025-12-01T00:00:00.000Z"),
        assumptions: { commissionPerContract: "2.5", slippageTicks: 1, riskPercentage: "1", initialBalance: "100000" },
      },
    });
    expect(backtestQueueAdd).toHaveBeenCalledTimes(1);
    expect(backtestQueueAdd).toHaveBeenCalledWith("run", { backtestId: "backtest-9" });
  });

  it("records no journal event and enqueues nothing when the experiment insert itself fails", async () => {
    researchRepository.getResearchHypothesis.mockResolvedValue({ id: "hypothesis-1" });
    instrumentsRepository.getInstrument.mockResolvedValue({ commissionPerContract: new Decimal("2.5") });
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(makeStrategyVersion());
    researchRepository.createResearchExperiment.mockRejectedValue(new Error("stage order"));

    await expect(service.createExperiment("hypothesis-1", RESEARCH_EXPERIMENT_INPUT as never)).rejects.toThrow(
      "stage order",
    );
    expect(journalEventsRepository.createJournalEvent).not.toHaveBeenCalled();
    expect(backtestQueueAdd).not.toHaveBeenCalled();
  });

  it("writes nothing at all (no StrategyVersion, no experiment, no job) when a precondition fails", async () => {
    researchRepository.getResearchHypothesis.mockResolvedValue({ id: "hypothesis-1" });
    researchRepository.assertResearchExperimentPreconditions.mockRejectedValue(
      new ResearchStageOrderError("hypothesis-1", "RESEARCH", "window overlap"),
    );
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(null);

    await expect(service.createExperiment("hypothesis-1", RESEARCH_EXPERIMENT_INPUT as never)).rejects.toThrow(
      ResearchStageOrderError,
    );
    expect(strategiesRepository.createStrategy).not.toHaveBeenCalled();
    expect(strategiesRepository.createStrategyVersion).not.toHaveBeenCalled();
    expect(researchRepository.createResearchExperiment).not.toHaveBeenCalled();
    expect(journalEventsRepository.createJournalEvent).not.toHaveBeenCalled();
    expect(backtestQueueAdd).not.toHaveBeenCalled();
  });
});

describe("ResearchService.markPaperCandidate", () => {
  let service: ResearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ResearchService({ add: vi.fn() } as never, { add: vi.fn() } as never);
  });

  it("throws when FINAL_TEST/WALK_FORWARD experiments are not both COMPLETED", async () => {
    researchRepository.listResearchExperimentsForHypothesis.mockResolvedValue([
      makeExperiment({ datasetRole: "FINAL_TEST", status: "COMPLETED" }),
    ]);

    await expect(service.markPaperCandidate("hypothesis-1", "strategy-version-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(strategiesRepository.findStrategyVersionBySourceHypothesis).not.toHaveBeenCalled();
    expect(strategiesRepository.markPaperCandidate).not.toHaveBeenCalled();
  });

  it("throws when strategyVersionId does not belong to this hypothesis (BLOCKER fix)", async () => {
    researchRepository.listResearchExperimentsForHypothesis.mockResolvedValue([
      makeExperiment({ datasetRole: "FINAL_TEST", status: "COMPLETED" }),
      makeExperiment({ id: "experiment-2", datasetRole: "WALK_FORWARD", status: "COMPLETED" }),
    ]);
    // This hypothesis's own StrategyVersion is "strategy-version-1", but the
    // caller passes a different id ("some-unrelated-strategy-version") that
    // independently happens to be WALK_FORWARD for a different hypothesis.
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(makeStrategyVersion());

    await expect(
      service.markPaperCandidate("hypothesis-1", "some-unrelated-strategy-version"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(researchRepository.listEnrichedJournalTradesForResearch).not.toHaveBeenCalled();
    expect(strategiesRepository.markPaperCandidate).not.toHaveBeenCalled();
  });

  it("throws when this hypothesis has no StrategyVersion of its own", async () => {
    researchRepository.listResearchExperimentsForHypothesis.mockResolvedValue([
      makeExperiment({ datasetRole: "FINAL_TEST", status: "COMPLETED" }),
      makeExperiment({ id: "experiment-2", datasetRole: "WALK_FORWARD", status: "COMPLETED" }),
    ]);
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(null);

    await expect(service.markPaperCandidate("hypothesis-1", "strategy-version-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(strategiesRepository.markPaperCandidate).not.toHaveBeenCalled();
  });

  it("throws when sample-size guardrails are not met over the combined dataset window", async () => {
    researchRepository.listResearchExperimentsForHypothesis.mockResolvedValue([
      makeExperiment({ datasetRole: "FINAL_TEST", status: "COMPLETED" }),
      makeExperiment({ id: "experiment-2", datasetRole: "WALK_FORWARD", status: "COMPLETED" }),
    ]);
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(makeStrategyVersion());
    researchRepository.listEnrichedJournalTradesForResearch.mockResolvedValue([]);

    await expect(service.markPaperCandidate("hypothesis-1", "strategy-version-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(strategiesRepository.markPaperCandidate).not.toHaveBeenCalled();
  });

  it("derives the guardrail window from only FINAL_TEST/WALK_FORWARD experiments and promotes when ownership and guardrails both pass", async () => {
    const experiments = [
      makeExperiment({
        id: "experiment-research",
        datasetRole: "RESEARCH",
        status: "COMPLETED",
        datasetWindowStart: new Date("2025-11-01T00:00:00.000Z"),
        datasetWindowEnd: new Date("2025-12-01T00:00:00.000Z"),
      }),
      makeExperiment({
        id: "experiment-final-test",
        datasetRole: "FINAL_TEST",
        status: "COMPLETED",
        datasetWindowStart: new Date("2026-01-01T00:00:00.000Z"),
        datasetWindowEnd: new Date("2026-03-01T00:00:00.000Z"),
      }),
      makeExperiment({
        id: "experiment-walk-forward",
        datasetRole: "WALK_FORWARD",
        status: "COMPLETED",
        datasetWindowStart: new Date("2026-03-01T00:00:00.000Z"),
        datasetWindowEnd: new Date("2026-05-01T00:00:00.000Z"),
      }),
    ];
    researchRepository.listResearchExperimentsForHypothesis.mockResolvedValue(experiments);
    strategiesRepository.findStrategyVersionBySourceHypothesis.mockResolvedValue(makeStrategyVersion());
    researchRepository.listEnrichedJournalTradesForResearch.mockResolvedValue(makeMatureTradeSet());
    strategiesRepository.markPaperCandidate.mockResolvedValue(makeStrategyVersion({ status: "PAPER_CANDIDATE" }));

    await service.markPaperCandidate("hypothesis-1", "strategy-version-1");

    // The earliest datasetWindowStart (FINAL_TEST, 2026-01-01) and latest
    // datasetWindowEnd (WALK_FORWARD, 2026-05-01) across only the
    // FINAL_TEST/WALK_FORWARD experiments — the RESEARCH stage's earlier
    // 2025-11-01 start is deliberately excluded (see the service's inline
    // comment: including it would make the guardrail easier, not harder,
    // to pass).
    expect(researchRepository.listEnrichedJournalTradesForResearch).toHaveBeenCalledWith({
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(strategiesRepository.markPaperCandidate).toHaveBeenCalledWith("strategy-version-1");
  });
});
