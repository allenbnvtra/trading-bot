import { describe, expect, it } from "vitest";
import {
  closeJournalTradeSchema,
  createJournalTradeSchema,
  createMarketSnapshotSchema,
  createRiskCalculationSchema,
  createSetupSchema,
  updateSetupStatusSchema,
} from "./journal";

describe("createMarketSnapshotSchema", () => {
  const valid = {
    instrumentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    timestamp: "2024-01-01T00:00:00.000Z",
    timeframe: "1h" as const,
  };

  it("accepts a minimal snapshot with only required fields", () => {
    expect(createMarketSnapshotSchema.safeParse(valid).success).toBe(true);
  });

  it("defaults metadata to an empty object", () => {
    const result = createMarketSnapshotSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.metadata).toEqual({});
  });

  it("rejects an invalid timeframe", () => {
    expect(createMarketSnapshotSchema.safeParse({ ...valid, timeframe: "2h" }).success).toBe(false);
  });

  it("accepts optional decimal fields when present", () => {
    const result = createMarketSnapshotSchema.safeParse({ ...valid, atr: "12.5", vwapDistance: "-3.25" });
    expect(result.success).toBe(true);
  });
});

describe("createSetupSchema", () => {
  const valid = {
    instrumentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    strategyId: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
    strategyVersionId: "3fa85f64-5717-4562-b3fc-2c963f66afa8",
    marketSnapshotId: "3fa85f64-5717-4562-b3fc-2c963f66afa9",
    direction: "LONG" as const,
    source: "MANUAL_TEST" as const,
    plannedEntry: "100",
    plannedStop: "95",
    plannedTarget1: "110",
  };

  it("accepts a well-formed setup", () => {
    expect(createSetupSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a zero plannedEntry", () => {
    expect(createSetupSchema.safeParse({ ...valid, plannedEntry: "0" }).success).toBe(false);
  });

  it("rejects an invalid source", () => {
    // TRADINGVIEW is a real, valid source (Milestone 3) — use a genuinely
    // unsupported value here instead.
    expect(createSetupSchema.safeParse({ ...valid, source: "TRADESTATION" }).success).toBe(false);
  });

  it("accepts a TRADINGVIEW-sourced setup with no plannedStop/plannedTarget1 yet", () => {
    const { plannedStop: _plannedStop, plannedTarget1: _plannedTarget1, ...withoutStopTarget } = valid;
    const result = createSetupSchema.safeParse({
      ...withoutStopTarget,
      source: "TRADINGVIEW",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional plannedTarget2", () => {
    const result = createSetupSchema.safeParse({ ...valid, plannedTarget2: "120" });
    expect(result.success).toBe(true);
  });
});

describe("updateSetupStatusSchema", () => {
  it("accepts a valid status", () => {
    expect(updateSetupStatusSchema.safeParse({ status: "READY" }).success).toBe(true);
  });

  it("rejects an invalid status", () => {
    expect(updateSetupStatusSchema.safeParse({ status: "APPROVED" }).success).toBe(false);
  });
});

describe("createRiskCalculationSchema", () => {
  it("accepts a well-formed request", () => {
    const result = createRiskCalculationSchema.safeParse({
      accountEquity: "50000",
      riskPercentage: "1",
    });
    expect(result.success).toBe(true);
  });

  it("defaults slippageTicks to 0", () => {
    const result = createRiskCalculationSchema.safeParse({ accountEquity: "50000", riskPercentage: "1" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.slippageTicks).toBe(0);
  });

  it("rejects a zero accountEquity", () => {
    const result = createRiskCalculationSchema.safeParse({ accountEquity: "0", riskPercentage: "1" });
    expect(result.success).toBe(false);
  });

  it("accepts a zero riskPercentage", () => {
    const result = createRiskCalculationSchema.safeParse({ accountEquity: "50000", riskPercentage: "0" });
    expect(result.success).toBe(true);
  });
});

describe("createJournalTradeSchema", () => {
  const valid = {
    instrumentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    strategyId: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
    strategyVersionId: "3fa85f64-5717-4562-b3fc-2c963f66afa8",
    direction: "LONG" as const,
    plannedEntry: "100",
    plannedStop: "95",
    executionMode: "PAPER" as const,
  };

  it("accepts a well-formed journal trade", () => {
    expect(createJournalTradeSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects executionMode BACKTEST (reserved for the analytics view, not literal rows)", () => {
    const result = createJournalTradeSchema.safeParse({ ...valid, executionMode: "BACKTEST" });
    expect(result.success).toBe(false);
  });
});

describe("closeJournalTradeSchema", () => {
  it("accepts a well-formed close request", () => {
    const result = closeJournalTradeSchema.safeParse({
      actualExit: "105",
      exitTimestamp: "2024-01-02T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a zero actualExit", () => {
    const result = closeJournalTradeSchema.safeParse({
      actualExit: "0",
      exitTimestamp: "2024-01-02T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
