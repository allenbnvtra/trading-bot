import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIProviderResponseError,
  MockAIProvider,
  type AIProvider,
  type AIProviderResult,
  type ResearchHypothesisOutput,
} from "@trading-copilot/ai-provider";

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

/** An ANTHROPIC-typed stand-in whose behavior each test controls, without any network. */
function fakeAnthropicProvider(
  generate: AIProvider["generateResearchHypothesis"],
): AIProvider {
  return { type: "ANTHROPIC", model: "claude-sonnet-5", generateResearchHypothesis: generate };
}

async function mockResult(): Promise<AIProviderResult<ResearchHypothesisOutput>> {
  const base = await new MockAIProvider().generateResearchHypothesis({ summary: baseSummary });
  return {
    ...base,
    model: "claude-sonnet-5-20260901",
    promptVersion: "1.0.0",
    tokensInput: 1200,
    tokensOutput: 400,
    costUsd: new Decimal("0.0096"),
  };
}

describe("AgentExecutionProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("on success: persists the hypothesis, marks the execution SUCCEEDED, records journal events", async () => {
    const agentExecution = buildAgentExecution();
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(agentExecution as never);
    vi.mocked(researchRepository.createResearchHypothesis).mockResolvedValue({
      id: "hyp-1",
      confidence: "LOW",
    } as never);
    vi.mocked(researchRepository.markAgentExecutionSucceeded).mockResolvedValue({
      ...agentExecution,
      status: "SUCCEEDED",
    } as never);

    const processor = new AgentExecutionProcessor(new MockAIProvider());

    await processor.process({ data: { agentExecutionId: "exec-1" } } as never);

    expect(researchRepository.createResearchHypothesis).toHaveBeenCalledTimes(1);
    expect(researchRepository.markAgentExecutionSucceeded).toHaveBeenCalledTimes(1);
    expect(researchRepository.markAgentExecutionSucceeded).toHaveBeenCalledWith(
      "exec-1",
      expect.objectContaining({ provider: "MOCK", model: "mock-v1", promptVersion: "1.0.0" }),
    );
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_STARTED", entityType: "AGENT_EXECUTION", entityId: "exec-1" }),
    );
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "RESEARCH_HYPOTHESIS_CREATED",
        entityType: "RESEARCH_HYPOTHESIS",
        entityId: "hyp-1",
        metadata: expect.objectContaining({ agentExecutionId: "exec-1" }),
      }),
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

    // The provider call succeeded (and was billed) before persistence
    // failed, so its raw response and usage are still audited.
    expect(researchRepository.markAgentExecutionFailed).toHaveBeenCalledWith(
      "exec-2",
      expect.objectContaining({
        errorMessage: "boom",
        outputRaw: expect.stringContaining("Mock hypothesis"),
        provider: "MOCK",
        model: "mock-v1",
      }),
    );
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_FAILED", entityType: "AGENT_EXECUTION", entityId: "exec-2" }),
    );
  });

  it("on success: overwrites the API's guessed provider/model/promptVersion with the ones that actually ran", async () => {
    // Row was created by an API process that guessed MOCK/mock-v1.
    const agentExecution = buildAgentExecution({ id: "exec-3", provider: "MOCK", model: "mock-v1" });
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(agentExecution as never);
    vi.mocked(researchRepository.createResearchHypothesis).mockResolvedValue({ id: "hyp-3", confidence: "LOW" } as never);
    const result = await mockResult();

    const processor = new AgentExecutionProcessor(fakeAnthropicProvider(async () => result));
    await processor.process({ data: { agentExecutionId: "exec-3" } } as never);

    expect(researchRepository.markAgentExecutionSucceeded).toHaveBeenCalledWith("exec-3", {
      provider: "ANTHROPIC",
      model: "claude-sonnet-5-20260901",
      promptVersion: "1.0.0",
      outputRaw: result.rawResponse,
      outputParsed: result.output,
      tokensInput: 1200,
      tokensOutput: 400,
      costUsd: result.costUsd,
    });
    expect(journalEventsRepository.createJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_STARTED", metadata: { provider: "ANTHROPIC" } }),
    );
  });

  it("on an AIProviderResponseError: persists the FAILED row with the raw response, usage, cost, and real model", async () => {
    const agentExecution = buildAgentExecution({ id: "exec-4" });
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(agentExecution as never);
    const rawResponse = JSON.stringify([{ type: "text", text: "no tool call" }]);
    const providerError = new AIProviderResponseError("AnthropicAIProvider: response contained no tool_use block", {
      rawResponse,
      tokensInput: 500,
      tokensOutput: 300,
      costUsd: new Decimal("0.006"),
      model: "claude-sonnet-5-20260901",
      promptVersion: "1.0.0",
    });

    const processor = new AgentExecutionProcessor(
      fakeAnthropicProvider(async () => {
        throw providerError;
      }),
    );

    await expect(processor.process({ data: { agentExecutionId: "exec-4" } } as never)).rejects.toBe(providerError);

    expect(researchRepository.createResearchHypothesis).not.toHaveBeenCalled();
    expect(researchRepository.markAgentExecutionFailed).toHaveBeenCalledWith("exec-4", {
      errorMessage: "AnthropicAIProvider: response contained no tool_use block",
      outputRaw: rawResponse,
      tokensInput: 500,
      tokensOutput: 300,
      costUsd: providerError.costUsd,
      provider: "ANTHROPIC",
      model: "claude-sonnet-5-20260901",
      promptVersion: "1.0.0",
    });
    const failedCall = vi.mocked(researchRepository.markAgentExecutionFailed).mock.calls[0]?.[1];
    expect(failedCall?.costUsd).toBeInstanceOf(Decimal);
    expect(failedCall?.costUsd?.toString()).toBe("0.006");
  });

  it("on a failure with no response at all: persists outputRaw null and no usage, but the real provider/requested model", async () => {
    const agentExecution = buildAgentExecution({ id: "exec-5" });
    vi.mocked(researchRepository.getAgentExecution).mockResolvedValue(agentExecution as never);

    const processor = new AgentExecutionProcessor(
      fakeAnthropicProvider(async () => {
        throw new Error("ECONNRESET");
      }),
    );

    await expect(processor.process({ data: { agentExecutionId: "exec-5" } } as never)).rejects.toThrow("ECONNRESET");

    // The row was created with the API's guess (MOCK/mock-v1); the worker
    // actually attempted ANTHROPIC/claude-sonnet-5.
    expect(researchRepository.markAgentExecutionFailed).toHaveBeenCalledWith("exec-5", {
      errorMessage: "ECONNRESET",
      outputRaw: null,
      provider: "ANTHROPIC",
      model: "claude-sonnet-5",
    });
  });
});
