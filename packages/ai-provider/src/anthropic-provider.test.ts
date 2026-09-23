import { describe, expect, it, vi } from "vitest";
import { STRATEGY_DEFINITION_BOUNDS } from "@trading-copilot/strategy-engine";
import { AnthropicAIProvider } from "./anthropic-provider";
import { AIProviderResponseError } from "./errors";
import { AI_PROVIDER_PROMPT_VERSION } from "./hypothesis-schema";

const VALID_TOOL_INPUT = {
  title: "Test hypothesis",
  statement: "A test statement long enough to pass validation.",
  rationale: "A test rationale.",
  confidence: "MEDIUM",
  proposedStrategyDefinition: {
    version: "1.0.0",
    direction: "LONG",
    entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 20, slowPeriod: 50 }],
    atrPeriod: 14,
    stopAtrMultiplier: 1,
    targetAtrMultiplier: 2,
  },
};

function makeMockClientWithContent(content: unknown[]) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content,
        usage: { input_tokens: 500, output_tokens: 300 },
        model: "claude-sonnet-5-20260901",
      }),
    },
  };
}

function makeMockClient(toolInput: unknown) {
  return makeMockClientWithContent([{ type: "tool_use", name: "propose_research_hypothesis", input: toolInput }]);
}

// 500 input tokens at $3/M + 300 output tokens at $15/M.
const EXPECTED_COST_USD = "0.006";

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("AnthropicAIProvider", () => {
  it("parses a valid tool_use response into a schema-valid hypothesis with token/cost tracking", async () => {
    const client = makeMockClient(VALID_TOOL_INPUT);
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    const result = await provider.generateResearchHypothesis({ summary: { overall: { tradeCount: 10 } } });

    expect(result.output.title).toBe("Test hypothesis");
    expect(result.tokensInput).toBe(500);
    expect(result.tokensOutput).toBe(300);
    expect(result.costUsd.toString()).toBe(EXPECTED_COST_USD);
    expect(result.model).toBe("claude-sonnet-5-20260901");
    expect(result.promptVersion).toBe(AI_PROVIDER_PROMPT_VERSION);
  });

  it("throws an AIProviderResponseError carrying raw response, usage, and cost when schema validation fails", async () => {
    const client = makeMockClient({ title: "" });
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    const error = await captureError(provider.generateResearchHypothesis({ summary: {} }));

    expect(error).toBeInstanceOf(AIProviderResponseError);
    const responseError = error as AIProviderResponseError;
    expect(responseError.message).toContain("schema validation");
    expect(JSON.parse(responseError.rawResponse)).toEqual([
      { type: "tool_use", name: "propose_research_hypothesis", input: { title: "" } },
    ]);
    expect(responseError.tokensInput).toBe(500);
    expect(responseError.tokensOutput).toBe(300);
    expect(responseError.costUsd.toString()).toBe(EXPECTED_COST_USD);
    expect(responseError.model).toBe("claude-sonnet-5-20260901");
    expect(responseError.promptVersion).toBe(AI_PROVIDER_PROMPT_VERSION);
  });

  it("throws an AIProviderResponseError carrying raw response, usage, and cost when there is no tool_use block", async () => {
    const content = [{ type: "text", text: "I would rather not call the tool." }];
    const client = makeMockClientWithContent(content);
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    const error = await captureError(provider.generateResearchHypothesis({ summary: {} }));

    expect(error).toBeInstanceOf(AIProviderResponseError);
    const responseError = error as AIProviderResponseError;
    expect(responseError.message).toContain("no tool_use block");
    expect(responseError.rawResponse).toBe(JSON.stringify(content));
    expect(responseError.tokensInput).toBe(500);
    expect(responseError.tokensOutput).toBe(300);
    expect(responseError.costUsd.toString()).toBe(EXPECTED_COST_USD);
    expect(responseError.model).toBe("claude-sonnet-5-20260901");
  });

  it("does not wrap a transport-level failure (no response exists, so there is nothing to preserve)", async () => {
    const client = { messages: { create: vi.fn().mockRejectedValue(new Error("ECONNRESET")) } };
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    const error = await captureError(provider.generateResearchHypothesis({ summary: {} }));

    expect(error).not.toBeInstanceOf(AIProviderResponseError);
    expect((error as Error).message).toBe("ECONNRESET");
  });

  it("advertises STRATEGY_DEFINITION_BOUNDS in the tool schema sent to the model", async () => {
    const client = makeMockClient(VALID_TOOL_INPUT);
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    await provider.generateResearchHypothesis({ summary: {} });

    const request = client.messages.create.mock.calls[0]?.[0] as {
      tools: Array<{ input_schema: { properties: { proposedStrategyDefinition: Record<string, unknown> } } }>;
      system: string;
    };
    const definitionSchema = request.tools[0]?.input_schema.properties.proposedStrategyDefinition as {
      properties: {
        atrPeriod: { minimum: number; maximum: number };
        stopAtrMultiplier: { minimum: number; maximum: number };
      };
    };
    expect(definitionSchema.properties.atrPeriod).toMatchObject({
      minimum: STRATEGY_DEFINITION_BOUNDS.minPeriod,
      maximum: STRATEGY_DEFINITION_BOUNDS.maxPeriod,
    });
    expect(definitionSchema.properties.stopAtrMultiplier).toMatchObject({
      minimum: STRATEGY_DEFINITION_BOUNDS.minAtrMultiplier,
      maximum: STRATEGY_DEFINITION_BOUNDS.maxAtrMultiplier,
    });
    expect(request.system).toContain(String(STRATEGY_DEFINITION_BOUNDS.maxPeriod));
  });
});
