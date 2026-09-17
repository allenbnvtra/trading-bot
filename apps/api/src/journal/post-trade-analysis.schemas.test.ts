import { describe, expect, it } from "vitest";
import { createPostTradeAnalysisSchema, postTradeAnalysisListQuerySchema } from "./post-trade-analysis.schemas";

describe("createPostTradeAnalysisSchema", () => {
  it("accepts a well-formed body and applies array/object defaults", () => {
    const result = createPostTradeAnalysisSchema.safeParse({
      tradeId: "11111111-1111-1111-1111-111111111111",
      tradeSource: "JOURNAL_TRADE",
      outcome: "LOSS",
      primaryCause: "STOP_TOO_TIGHT",
      confidence: "0.75",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributingFactors).toEqual([]);
      expect(result.data.evidence).toEqual({});
      expect(result.data.researchHypotheses).toEqual([]);
    }
  });

  it("rejects an invalid tradeSource", () => {
    const result = createPostTradeAnalysisSchema.safeParse({
      tradeId: "11111111-1111-1111-1111-111111111111",
      tradeSource: "SOMETHING_ELSE",
      outcome: "LOSS",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid outcome", () => {
    const result = createPostTradeAnalysisSchema.safeParse({
      tradeId: "11111111-1111-1111-1111-111111111111",
      tradeSource: "JOURNAL_TRADE",
      outcome: "PROFIT",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence value outside 0-1", () => {
    const result = createPostTradeAnalysisSchema.safeParse({
      tradeId: "11111111-1111-1111-1111-111111111111",
      tradeSource: "JOURNAL_TRADE",
      outcome: "WIN",
      confidence: "1.5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid tradeId", () => {
    const result = createPostTradeAnalysisSchema.safeParse({
      tradeId: "not-a-uuid",
      tradeSource: "JOURNAL_TRADE",
      outcome: "WIN",
    });
    expect(result.success).toBe(false);
  });
});

describe("postTradeAnalysisListQuerySchema", () => {
  it("allows an empty query", () => {
    expect(postTradeAnalysisListQuerySchema.safeParse({}).success).toBe(true);
  });

  it("rejects an invalid tradeSource filter", () => {
    expect(postTradeAnalysisListQuerySchema.safeParse({ tradeSource: "NOPE" }).success).toBe(false);
  });
});
