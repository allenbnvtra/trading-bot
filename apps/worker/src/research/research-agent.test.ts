import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { MockAIProvider } from "@trading-copilot/ai-provider";
import type { ResearchDataSummary } from "@trading-copilot/analytics";
import { ResearchAgent } from "./research-agent";

function emptySummary(): ResearchDataSummary {
  return {
    overall: {
      tradeCount: 0, wins: 0, losses: 0, winRate: new Decimal(0), grossProfit: new Decimal(0),
      grossLoss: new Decimal(0), netPnl: new Decimal(0), averagePnl: new Decimal(0), expectancy: new Decimal(0),
      averageR: new Decimal(0), profitFactor: null, averageWinner: new Decimal(0), averageLoser: new Decimal(0),
      largestWinner: new Decimal(0), largestLoser: new Decimal(0), maxDrawdown: new Decimal(0),
      maxDrawdownPercent: null, maximumConsecutiveWins: 0, maximumConsecutiveLosses: 0, mfeAverage: null,
      maeAverage: null, totalFees: new Decimal(0), averageSlippage: null,
    },
    sampleWindowStart: null, sampleWindowEnd: null, bySession: [], byTimeOfDay: [], byMarketRegime: [],
    byDirection: [], vwapDistance: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
    volumePercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
    atrPercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
  };
}

describe("ResearchAgent", () => {
  it("serializes a ResearchDataSummary into JSON-safe input and returns a schema-valid hypothesis", async () => {
    const agent = new ResearchAgent(new MockAIProvider());
    const result = await agent.generateHypothesis(emptySummary());
    expect(result.output.title.length).toBeGreaterThan(0);
    expect(result.model).toBe("mock-v1");
  });

  it("produces byte-identical output for repeated calls with the same logical summary, proving the serialization chain is deterministic", async () => {
    const agent = new ResearchAgent(new MockAIProvider());
    const first = await agent.generateHypothesis(emptySummary());
    const second = await agent.generateHypothesis(emptySummary());
    expect(second.rawResponse).toBe(first.rawResponse);
    expect(second.output).toEqual(first.output);
  });

  it("converts every Decimal field in the summary to a plain string before it reaches the provider", async () => {
    const summary = emptySummary();
    summary.overall.tradeCount = 12;
    summary.overall.winRate = new Decimal("0.6667");
    summary.overall.netPnl = new Decimal("1234.5678");

    let capturedSummary: Record<string, unknown> | undefined;
    const capturingProvider = new MockAIProvider();
    const originalGenerate = capturingProvider.generateResearchHypothesis.bind(capturingProvider);
    capturingProvider.generateResearchHypothesis = async (input) => {
      capturedSummary = input.summary;
      return originalGenerate(input);
    };

    const agent = new ResearchAgent(capturingProvider);
    await agent.generateHypothesis(summary);

    expect(capturedSummary).toBeDefined();
    const overall = (capturedSummary as Record<string, unknown>).overall as Record<string, unknown>;
    expect(overall.winRate).toBe("0.6667");
    expect(overall.netPnl).toBe("1234.5678");
    expect(overall.tradeCount).toBe(12);
  });
});
