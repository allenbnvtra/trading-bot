import { describe, expect, it } from "vitest";
import { createResearchExperimentRequestSchema, generateResearchHypothesisRequestSchema } from "./research";

describe("generateResearchHypothesisRequestSchema", () => {
  it("accepts an empty body (research scope defaults to all data)", () => {
    expect(generateResearchHypothesisRequestSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys", () => {
    expect(() => generateResearchHypothesisRequestSchema.parse({ strategyId: "s1", bogus: true })).toThrow();
  });
});

describe("createResearchExperimentRequestSchema", () => {
  it("parses a valid RESEARCH-stage request", () => {
    const input = {
      datasetRole: "RESEARCH",
      datasetWindowStart: "2026-01-01T00:00:00.000Z",
      datasetWindowEnd: "2026-04-01T00:00:00.000Z",
      instrumentId: "11111111-1111-1111-1111-111111111111",
      timeframe: "5m",
      initialBalance: "10000",
      riskPercentage: "1",
      slippageTicks: 1,
    };
    expect(createResearchExperimentRequestSchema.parse(input)).toEqual(input);
  });

  it("rejects an invalid datasetRole", () => {
    expect(() =>
      createResearchExperimentRequestSchema.parse({
        datasetRole: "BOGUS",
        datasetWindowStart: "2026-01-01T00:00:00.000Z",
        datasetWindowEnd: "2026-04-01T00:00:00.000Z",
        instrumentId: "11111111-1111-1111-1111-111111111111",
        timeframe: "5m",
        initialBalance: "10000",
        riskPercentage: "1",
        slippageTicks: 1,
      }),
    ).toThrow();
  });
});

describe("createResearchExperimentRequestSchema window ordering", () => {
  const base = {
    datasetRole: "VALIDATION",
    instrumentId: "11111111-1111-1111-1111-111111111111",
    timeframe: "5m",
    initialBalance: "10000",
    riskPercentage: "1",
    slippageTicks: 1,
  };

  it("rejects a window whose end is not after its start", () => {
    expect(() =>
      createResearchExperimentRequestSchema.parse({
        ...base,
        datasetWindowStart: "2026-04-01T00:00:00.000Z",
        datasetWindowEnd: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/datasetWindowEnd must be after datasetWindowStart/);
    expect(() =>
      createResearchExperimentRequestSchema.parse({
        ...base,
        datasetWindowStart: "2026-04-01T00:00:00.000Z",
        datasetWindowEnd: "2026-04-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
