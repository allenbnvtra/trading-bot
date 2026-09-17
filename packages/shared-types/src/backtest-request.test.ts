import { describe, expect, it } from "vitest";
import { createBacktestRequestSchema } from "./backtest-request";

const validRequest = {
  instrumentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  strategyVersionId: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
  timeframe: "1h" as const,
  startDate: "2024-01-01T00:00:00.000Z",
  endDate: "2024-06-01T00:00:00.000Z",
  initialBalance: "50000",
  riskPercentage: "1",
  slippageTicks: 1,
};

describe("createBacktestRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(createBacktestRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("defaults slippageTicks to 0 when omitted", () => {
    const { slippageTicks: _slippageTicks, ...withoutSlippage } = validRequest;
    const result = createBacktestRequestSchema.safeParse(withoutSlippage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slippageTicks).toBe(0);
    }
  });

  it("rejects a negative slippageTicks", () => {
    const result = createBacktestRequestSchema.safeParse({ ...validRequest, slippageTicks: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID instrumentId", () => {
    const result = createBacktestRequestSchema.safeParse({ ...validRequest, instrumentId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid timeframe", () => {
    const result = createBacktestRequestSchema.safeParse({ ...validRequest, timeframe: "2h" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO startDate", () => {
    const result = createBacktestRequestSchema.safeParse({ ...validRequest, startDate: "yesterday" });
    expect(result.success).toBe(false);
  });
});
