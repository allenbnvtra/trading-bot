import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchBudgetExceededError } from "@trading-copilot/database";
import { ResearchService } from "./research.service";

const { researchRepository } = vi.hoisted(() => ({
  researchRepository: {
    getTodayResearchSpend: vi.fn(),
    createAgentExecution: vi.fn(),
    listEnrichedJournalTradesForResearch: vi.fn(),
    listResearchHypotheses: vi.fn(),
    getResearchHypothesis: vi.fn(),
    listResearchExperimentsForHypothesis: vi.fn(),
    getAgentExecution: vi.fn(),
    createResearchExperiment: vi.fn(),
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
  return { ...actual, researchRepository };
});

const RESEARCH_DAILY_TOKEN_BUDGET_ENV = "RESEARCH_DAILY_TOKEN_BUDGET";

describe("ResearchService.generateHypothesis", () => {
  let queueAdd: ReturnType<typeof vi.fn>;
  let service: ResearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    queueAdd = vi.fn().mockResolvedValue(undefined);
    service = new ResearchService({ add: queueAdd } as never);
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
