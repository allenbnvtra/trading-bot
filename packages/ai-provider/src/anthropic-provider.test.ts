import { describe, expect, it, vi } from "vitest";
import { AnthropicAIProvider } from "./anthropic-provider";

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

function makeMockClient(toolInput: unknown) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "tool_use", name: "propose_research_hypothesis", input: toolInput }],
        usage: { input_tokens: 500, output_tokens: 300 },
        model: "claude-sonnet-5",
      }),
    },
  };
}

describe("AnthropicAIProvider", () => {
  it("parses a valid tool_use response into a schema-valid hypothesis with token/cost tracking", async () => {
    const client = makeMockClient(VALID_TOOL_INPUT);
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    const result = await provider.generateResearchHypothesis({ summary: { overall: { tradeCount: 10 } } });

    expect(result.output.title).toBe("Test hypothesis");
    expect(result.tokensInput).toBe(500);
    expect(result.tokensOutput).toBe(300);
    expect(result.costUsd.greaterThan(0)).toBe(true);
  });

  it("throws (never guesses) when the response fails schema validation", async () => {
    const client = makeMockClient({ title: "" });
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    await expect(provider.generateResearchHypothesis({ summary: {} })).rejects.toThrow();
  });
});
