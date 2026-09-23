import { describe, expect, it } from "vitest";
import { executeSetupSchema, skipSetupSchema } from "./notifications";

describe("executeSetupSchema", () => {
  it("accepts a full MANUAL_LIVE execution", () => {
    const result = executeSetupSchema.safeParse({
      executionMode: "MANUAL_LIVE",
      actualEntry: "21425.25",
      quantity: 1,
      entryTimestamp: "2026-09-23T10:00:00.000Z",
      actualFees: "4.50",
      actualSlippage: "0.25",
      notes: "filled a tick worse than planned",
    });
    expect(result.success).toBe(true);
  });

  it("rejects BACKTEST as an execution mode", () => {
    const result = executeSetupSchema.safeParse({
      executionMode: "BACKTEST",
      actualEntry: "21425.25",
      quantity: 1,
      entryTimestamp: "2026-09-23T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("skipSetupSchema", () => {
  it("accepts no reason at all", () => {
    expect(skipSetupSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a known reason", () => {
    expect(skipSetupSchema.safeParse({ reason: "PRICE_MOVED" }).success).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(skipSetupSchema.safeParse({ reason: "BAD_VIBES" }).success).toBe(false);
  });
});
