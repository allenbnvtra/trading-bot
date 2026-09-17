import { describe, expect, it } from "vitest";
import { analyticsComparisonQuerySchema } from "./analytics.schemas";

describe("analyticsComparisonQuerySchema", () => {
  it("leaves groupBy undefined when omitted", () => {
    const result = analyticsComparisonQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groupBy).toBeUndefined();
    }
  });

  it("splits a comma-separated groupBy into an array", () => {
    const result = analyticsComparisonQuerySchema.safeParse({ groupBy: "strategyId,direction" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groupBy).toEqual(["strategyId", "direction"]);
    }
  });

  it("rejects a groupBy field outside the valid GroupByField set", () => {
    const result = analyticsComparisonQuerySchema.safeParse({ groupBy: "strategyId,notAField" });
    expect(result.success).toBe(false);
  });
});
