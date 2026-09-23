import { describe, expect, it } from "vitest";
import { MockAIProvider } from "./mock-provider";
import { researchHypothesisOutputSchema } from "./hypothesis-schema";

describe("MockAIProvider", () => {
  it("produces a schema-valid hypothesis with no network access", async () => {
    const provider = new MockAIProvider();
    const result = await provider.generateResearchHypothesis({
      summary: {
        overall: { tradeCount: 120, winRate: "0.55", averageR: "0.8", expectancy: "12.5", profitFactor: "1.6" },
        bySession: [{ value: "LONDON", sampleSize: 60, winRate: "0.6", averageR: "1.1", profitFactor: "1.9" }],
      },
    });

    expect(() => researchHypothesisOutputSchema.parse(result.output)).not.toThrow();
    expect(result.model).toBe("mock-v1");
    expect(result.tokensInput).toBeGreaterThan(0);
    expect(result.costUsd.toString()).toBe("0");
  });

  it("is deterministic: identical input produces byte-identical output", async () => {
    const provider = new MockAIProvider();
    const input = { summary: { overall: { tradeCount: 10, winRate: "0.5", averageR: "0.1", expectancy: "1", profitFactor: null } } };
    const first = await provider.generateResearchHypothesis(input);
    const second = await provider.generateResearchHypothesis(input);
    expect(first.rawResponse).toBe(second.rawResponse);
  });
});
