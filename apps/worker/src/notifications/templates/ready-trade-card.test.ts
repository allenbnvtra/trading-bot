import { describe, expect, it } from "vitest";
import { formatReadyTradeCard, formatSetupStatusNotice } from "./ready-trade-card";

describe("formatReadyTradeCard", () => {
  it("renders every field when all are present", () => {
    const card = formatReadyTradeCard({
      instrumentSymbol: "NQ",
      direction: "LONG",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      timeframe: "5m",
      entry: "21,425.25",
      stop: "21,409.75",
      target1: "21,456.25",
      target2: "21,487.25",
      stopDistancePoints: "15.5 points",
      riskAmount: "$93",
      quantity: "1 contract",
      riskReward: "2.0R",
      expiresAt: "10:15 ET",
      status: "READY",
    });
    expect(card).toContain("🟢 TRADE READY");
    expect(card).toContain("NQ");
    expect(card).toContain("LONG");
    expect(card).toContain("Opening Pullback v2.4.1");
    expect(card).toContain("21,425.25");
    expect(card).toContain("2.0R");
  });

  it("renders NOT AVAILABLE for a missing target2 rather than fabricating a value", () => {
    const card = formatReadyTradeCard({
      instrumentSymbol: "NQ",
      direction: "LONG",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      timeframe: "5m",
      entry: "21,425.25",
      stop: "21,409.75",
      target1: "21,456.25",
      target2: null,
      stopDistancePoints: "15.5 points",
      riskAmount: "$93",
      quantity: "1 contract",
      riskReward: "2.0R",
      expiresAt: null,
      status: "READY",
    });
    expect(card).toContain("NOT AVAILABLE");
    expect(card).not.toContain("undefined");
    expect(card).not.toContain("null");
  });

  it("renders UNKNOWN for a missing riskReward (no risk calculation exists yet)", () => {
    const card = formatReadyTradeCard({
      instrumentSymbol: "NQ",
      direction: "SHORT",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      timeframe: "5m",
      entry: "21,425.25",
      stop: null,
      target1: null,
      target2: null,
      stopDistancePoints: null,
      riskAmount: null,
      quantity: null,
      riskReward: null,
      expiresAt: null,
      status: "READY",
    });
    expect(card).toContain("UNKNOWN");
  });
});

describe("formatSetupStatusNotice", () => {
  it("renders the exact INVALIDATED example from the design brief", () => {
    const notice = formatSetupStatusNotice({
      setupId: "setup-123",
      notificationType: "SETUP_INVALIDATED",
      instrumentSymbol: "NQ",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      status: "INVALIDATED",
    });
    expect(notice).toContain("⚪ SETUP INVALIDATED\n\nNQ — Opening Pullback v2.4.1");
  });

  it("renders a distinct emoji/header per notification type", () => {
    const prepare = formatSetupStatusNotice({
      setupId: "setup-1",
      notificationType: "SETUP_PREPARE",
      instrumentSymbol: "ES",
      strategyName: "Gap Fade",
      strategyVersion: "1.0.0",
      status: "PREPARE",
    });
    expect(prepare).toContain("🟡 SETUP PREPARE");

    const expired = formatSetupStatusNotice({
      setupId: "setup-2",
      notificationType: "SETUP_EXPIRED",
      instrumentSymbol: "ES",
      strategyName: "Gap Fade",
      strategyVersion: "1.0.0",
      status: "EXPIRED",
    });
    expect(expired).toContain("⚫ SETUP EXPIRED");

    const rejected = formatSetupStatusNotice({
      setupId: "setup-3",
      notificationType: "SETUP_REJECTED",
      instrumentSymbol: "ES",
      strategyName: "Gap Fade",
      strategyVersion: "1.0.0",
      status: "REJECTED",
    });
    expect(rejected).toContain("🔴 SETUP REJECTED");
  });

  it("includes the setupId for traceability and never leaks undefined/null", () => {
    const notice = formatSetupStatusNotice({
      setupId: "setup-abc-123",
      notificationType: "SETUP_PREPARE",
      instrumentSymbol: "NQ",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      status: "PREPARE",
    });
    expect(notice).toContain("setup-abc-123");
    expect(notice).not.toContain("undefined");
    expect(notice).not.toContain("null");
  });
});
