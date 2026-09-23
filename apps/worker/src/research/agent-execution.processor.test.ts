import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@trading-copilot/ai-provider";

const baseSummary = {
  overall: { tradeCount: 0 },
  sampleWindowStart: null,
  sampleWindowEnd: null,
  bySession: [],
  byTimeOfDay: [],
  byMarketRegime: [],
  byDirection: [],
  vwapDistance: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
  volumePercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
  atrPercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
};

/**
 * researchRepository and journalEventsRepository are plain exported objects
 * from @trading-copilot/database (not NestJS-managed providers), so they are
 * mocked the same way notification-send.processor.test.ts mocks
 * notificationDeliveriesRepository et al.: a vi.mock of the whole package,
 * not constructor injection. See AgentExecutionProcessor's own doc comment
 * for why only AIProvider is constructor-injected.
 */
vi.mock("@trading-copilot/database", () => ({
  researchRepository: {
    getAgentExecution: vi.fn(),
    markAgentExecutionSucceeded: vi.fn(),
    markAgentExecutionFailed: vi.fn(),
    createResearchHypothesis: vi.fn(),
  },
  journalEventsRepository: {
    createJournalEvent: vi.fn(),
  },
}));

import { journalEventsRepository, researchRepository } from "@trading-copilot/database";
import { AgentExecutionProcessor } from "./agent-execution.processor";

function buildAgentExecution(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "exec-1",
    agentType: "RESEARCH",
    provider: "MOCK",
    model: "mock-v1",
    promptVersion: "1.0.0",
    inputSummary: baseSummary,
    outputRaw: null,
    outputParsed: null,
    status: "RUNNING",
    errorMessage: null,
    tokensInput: null,
    tokensOutput: null,
    costUsd: null,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

describe("AgentExecutionProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("on success: persists the hypothesis, marks the execution SUCCEEDED, records journal events", async () => {
    const agentExecution = buildAgentExecution();
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(agentExecution as never);
    vi.mocked(researchRepository.createResearchHypothesis).mockResolvedValue({ id: "hyp-1" } as never);
    vi.mocked(researchRepository.markAgentExecutionSucceeded).mockResolvedValue({
      ...agentExecution,
      status: "SUCCEEDED",
    } as never);

    const processor = new AgentExecutionProcessor(new MockAIProvider());

    await processor.process({ data: { agentExecutionId: "exec-1" } } as never);

    expect(researchRepository.createResearchHypothesis).toHaveBeenCalledTimes(1);
    expect(researchRepository.markAgentExecutionSucceeded).toHaveBeenCalledTimes(1);
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_STARTED", entityType: "AGENT_EXECUTION", entityId: "exec-1" }),
    );
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_COMPLETED", entityType: "AGENT_EXECUTION", entityId: "exec-1" }),
    );
  });

  it("throws if the AgentExecution row cannot be found (never silently no-ops)", async () => {
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(null);

    const processor = new AgentExecutionProcessor(new MockAIProvider());

    await expect(processor.process({ data: { agentExecutionId: "missing" } } as never)).rejects.toThrow();
  });

  it("on failure: marks the execution FAILED, records an AGENT_FAILED journal event, and rethrows", async () => {
    const agentExecution = buildAgentExecution({ id: "exec-2" });
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(agentExecution as never);
    vi.mocked(researchRepository.createResearchHypothesis).mockRejectedValue(new Error("boom"));
    vi.mocked(researchRepository.markAgentExecutionFailed).mockResolvedValue({
      ...agentExecution,
      status: "FAILED",
    } as never);

    const processor = new AgentExecutionProcessor(new MockAIProvider());

    await expect(processor.process({ data: { agentExecutionId: "exec-2" } } as never)).rejects.toThrow("boom");

    expect(researchRepository.markAgentExecutionFailed).toHaveBeenCalledWith(
      "exec-2",
      expect.objectContaining({ errorMessage: "boom" }),
    );
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_FAILED", entityType: "AGENT_EXECUTION", entityId: "exec-2" }),
    );
  });
});
