import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { assertSampleSizeGuardrails, buildResearchDataSummary, type EnrichedJournalTrade } from "./research-summary";

function trade(overrides: Partial<EnrichedJournalTrade>): EnrichedJournalTrade {
  return {
    source: "JOURNAL",
    id: "t1",
    strategyId: "s1",
    strategyVersionId: "sv1",
    instrumentId: "i1",
    direction: "LONG",
    executionMode: "MANUAL_LIVE",
    entryTimestamp: new Date("2026-01-01T00:00:00Z"),
    exitTimestamp: new Date("2026-01-01T01:00:00Z"),
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
    context: { session: "LONDON", timeOfDay: "MORNING", marketRegime: "TRENDING", vwapDistance: new Decimal(1.2), volumePercentile: new Decimal(60), atrPercentile: new Decimal(40) },
    ...overrides,
  } as EnrichedJournalTrade;
}

describe("buildResearchDataSummary", () => {
  it("buckets by session/timeOfDay/marketRegime and reports continuous-variable comparisons", () => {
    const winner = trade({ id: "w1", netPnl: new Decimal(100) });
    const loser = trade({
      id: "l1",
      netPnl: new Decimal(-50),
      context: { session: "NEW_YORK", timeOfDay: "AFTERNOON", marketRegime: "RANGING", vwapDistance: new Decimal(3.5), volumePercentile: new Decimal(90), atrPercentile: new Decimal(80) },
    });

    const summary = buildResearchDataSummary([winner, loser]);

    expect(summary.overall.tradeCount).toBe(2);
    expect(summary.bySession.map((b) => b.value).sort()).toEqual(["LONDON", "NEW_YORK"]);
    expect(summary.vwapDistance.averageAmongWinners?.toString()).toBe("1.2");
    expect(summary.vwapDistance.averageAmongLosers?.toString()).toBe("3.5");
  });

  it("buckets a null context field under UNKNOWN rather than dropping the trade", () => {
    const summary = buildResearchDataSummary([trade({ context: null })]);
    expect(summary.bySession).toEqual([expect.objectContaining({ value: "UNKNOWN", sampleSize: 1 })]);
  });
});

describe("assertSampleSizeGuardrails", () => {
  it("fails when both calendar days and setup count are below the minimum", () => {
    const result = assertSampleSizeGuardrails({
      sampleWindowStart: new Date("2026-01-01T00:00:00Z"),
      sampleWindowEnd: new Date("2026-01-10T00:00:00Z"),
      overall: { tradeCount: 5 },
    });
    expect(result.passes).toBe(false);
    expect(result.reasons.length).toBe(2);
  });

  it("passes when both guardrails are satisfied", () => {
    const result = assertSampleSizeGuardrails({
      sampleWindowStart: new Date("2026-01-01T00:00:00Z"),
      sampleWindowEnd: new Date("2026-04-01T00:00:00Z"),
      overall: { tradeCount: 120 },
    });
    expect(result.passes).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
