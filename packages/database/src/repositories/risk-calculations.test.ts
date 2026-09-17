import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  calculatePositionSize,
  calculateRiskBudget,
  calculateRiskPerContract,
  calculateRiskReward,
  calculateStopDistancePoints,
  calculateStopDistanceTicks,
} from "@trading-copilot/risk-engine";
import { computeRiskCalculation } from "./risk-calculations";

/**
 * computeRiskCalculation is the pure numeric core extracted from
 * createRiskCalculation (see that module's doc comment) — this asserts its
 * output is byte-for-byte what calling packages/risk-engine's functions
 * directly, in the documented order, would produce for the same inputs.
 */
describe("computeRiskCalculation", () => {
  const instrument = {
    tickSize: new Decimal("0.25"),
    pointValue: new Decimal("50"),
    tickValue: new Decimal("12.50"),
    commissionPerContract: new Decimal("2.50"),
  };

  it("matches calling packages/risk-engine functions directly with the same inputs", () => {
    const entryPrice = new Decimal("5100");
    const stopPrice = new Decimal("5088");
    const target = new Decimal("5124");
    const input = {
      accountEquity: new Decimal("100000"),
      riskPercentage: new Decimal("1"),
      slippageTicks: 2,
    };

    const result = computeRiskCalculation(entryPrice, stopPrice, target, instrument, input);

    const expectedStopDistancePoints = calculateStopDistancePoints(entryPrice, stopPrice);
    const expectedStopDistanceTicks = calculateStopDistanceTicks(
      expectedStopDistancePoints,
      instrument.tickSize,
    );
    const expectedRiskBudget = calculateRiskBudget(input.accountEquity, input.riskPercentage);
    const expectedSlippage = new Decimal(input.slippageTicks)
      .times(instrument.tickSize)
      .times(instrument.pointValue);
    const expectedRiskPerUnit = calculateRiskPerContract(
      expectedStopDistancePoints,
      instrument.pointValue,
      instrument.commissionPerContract,
      expectedSlippage,
    );
    const expectedQuantity = calculatePositionSize(expectedRiskBudget, expectedRiskPerUnit);
    const expectedTotalRisk = expectedRiskPerUnit.times(expectedQuantity);
    const expectedRiskReward = calculateRiskReward(entryPrice, stopPrice, target);

    expect(result.stopDistancePoints.toString()).toBe(expectedStopDistancePoints.toString());
    expect(result.stopDistanceTicks.toString()).toBe(expectedStopDistanceTicks.toString());
    expect(result.riskBudget.toString()).toBe(expectedRiskBudget.toString());
    expect(result.estimatedSlippage.toString()).toBe(expectedSlippage.toString());
    expect(result.riskPerUnit.toString()).toBe(expectedRiskPerUnit.toString());
    expect(result.calculatedQuantity).toBe(expectedQuantity);
    expect(result.estimatedTotalRisk.toString()).toBe(expectedTotalRisk.toString());
    expect(result.riskReward.toString()).toBe(expectedRiskReward.toString());

    // Concrete expected values for this fixture (12-point stop, 24-point
    // target, 2:1 reward:risk, $100k account risking 1%, 2 ticks slippage).
    expect(result.stopDistancePoints.toString()).toBe("12");
    expect(result.stopDistanceTicks.toString()).toBe("48");
    expect(result.riskBudget.toString()).toBe("1000");
    expect(result.estimatedSlippage.toString()).toBe("25");
    expect(result.riskPerUnit.toString()).toBe("627.5");
    expect(result.calculatedQuantity).toBe(1);
    expect(result.estimatedTotalRisk.toString()).toBe("627.5");
    expect(result.riskReward.toString()).toBe("2");
  });

  it("persists calculatedQuantity 0 rather than treating it as an error (undersized account)", () => {
    const entryPrice = new Decimal("5100");
    const stopPrice = new Decimal("5088");
    const target = new Decimal("5124");
    const input = {
      accountEquity: new Decimal("1000"),
      riskPercentage: new Decimal("1"),
      slippageTicks: 2,
    };

    const result = computeRiskCalculation(entryPrice, stopPrice, target, instrument, input);

    expect(result.calculatedQuantity).toBe(0);
    expect(result.estimatedTotalRisk.toString()).toBe("0");
  });
});
