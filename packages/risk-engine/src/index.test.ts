import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  RiskEngineError,
  calculateGrossPnl,
  calculateNetPnl,
  calculatePositionSize,
  calculateRMultiple,
  calculateRiskBudget,
  calculateRiskPerContract,
  calculateRiskReward,
  calculateStopDistancePoints,
  calculateStopDistanceTicks,
} from "./index";

const D = (value: string | number) => new Decimal(value);

describe("calculateStopDistancePoints", () => {
  it("returns the absolute distance for a LONG (stop below entry)", () => {
    expect(calculateStopDistancePoints(D(100), D(95)).toString()).toBe("5");
  });

  it("returns the absolute distance for a SHORT (stop above entry)", () => {
    expect(calculateStopDistancePoints(D(95), D(100)).toString()).toBe("5");
  });

  it("throws when entry equals stop (zero stop distance)", () => {
    expect(() => calculateStopDistancePoints(D(100), D(100))).toThrow(RiskEngineError);
  });

  it("throws on NaN entry", () => {
    expect(() => calculateStopDistancePoints(new Decimal(NaN), D(100))).toThrow(RiskEngineError);
  });

  it("throws on Infinity stop", () => {
    expect(() => calculateStopDistancePoints(D(100), new Decimal(Infinity))).toThrow(RiskEngineError);
  });
});

describe("calculateStopDistanceTicks", () => {
  it("divides points by tick size", () => {
    expect(calculateStopDistanceTicks(D(5), D("0.25")).toString()).toBe("20");
  });

  it("throws when tickSize is zero", () => {
    expect(() => calculateStopDistanceTicks(D(5), D(0))).toThrow(RiskEngineError);
  });

  it("throws when tickSize is negative", () => {
    expect(() => calculateStopDistanceTicks(D(5), D(-1))).toThrow(RiskEngineError);
  });

  it("throws when stopDistancePoints is zero or negative", () => {
    expect(() => calculateStopDistanceTicks(D(0), D("0.25"))).toThrow(RiskEngineError);
    expect(() => calculateStopDistanceTicks(D(-5), D("0.25"))).toThrow(RiskEngineError);
  });
});

describe("calculateRiskBudget", () => {
  it("computes equity * riskPercentage / 100", () => {
    expect(calculateRiskBudget(D(10000), D(1)).toString()).toBe("100");
  });

  it("allows riskPercentage of 0 (budget of 0)", () => {
    expect(calculateRiskBudget(D(10000), D(0)).toString()).toBe("0");
  });

  it("throws when riskPercentage is negative", () => {
    expect(() => calculateRiskBudget(D(10000), D(-1))).toThrow(RiskEngineError);
  });

  it("throws when accountEquity is zero", () => {
    expect(() => calculateRiskBudget(D(0), D(1))).toThrow(RiskEngineError);
  });

  it("throws when accountEquity is negative", () => {
    expect(() => calculateRiskBudget(D(-100), D(1))).toThrow(RiskEngineError);
  });

  it("throws on NaN/Infinity input", () => {
    expect(() => calculateRiskBudget(new Decimal(NaN), D(1))).toThrow(RiskEngineError);
    expect(() => calculateRiskBudget(D(10000), new Decimal(Infinity))).toThrow(RiskEngineError);
  });
});

describe("calculateRiskPerContract", () => {
  it("computes stopDistancePoints * pointValue + commission + slippage", () => {
    // 5 points * 50 pointValue + 2.5 commission + 1.5 slippage = 254
    expect(
      calculateRiskPerContract(D(5), D(50), D("2.5"), D("1.5")).toString(),
    ).toBe("254");
  });

  it("allows zero commission and zero slippage", () => {
    expect(calculateRiskPerContract(D(5), D(50), D(0), D(0)).toString()).toBe("250");
  });

  it("throws when pointValue is zero or negative", () => {
    expect(() => calculateRiskPerContract(D(5), D(0), D(0), D(0))).toThrow(RiskEngineError);
    expect(() => calculateRiskPerContract(D(5), D(-1), D(0), D(0))).toThrow(RiskEngineError);
  });

  it("throws when stopDistancePoints is zero or negative", () => {
    expect(() => calculateRiskPerContract(D(0), D(50), D(0), D(0))).toThrow(RiskEngineError);
    expect(() => calculateRiskPerContract(D(-1), D(50), D(0), D(0))).toThrow(RiskEngineError);
  });

  it("throws when commission or slippage is negative", () => {
    expect(() => calculateRiskPerContract(D(5), D(50), D(-1), D(0))).toThrow(RiskEngineError);
    expect(() => calculateRiskPerContract(D(5), D(50), D(0), D(-1))).toThrow(RiskEngineError);
  });

  it("throws on NaN/Infinity input", () => {
    expect(() => calculateRiskPerContract(new Decimal(NaN), D(50), D(0), D(0))).toThrow(
      RiskEngineError,
    );
    expect(() =>
      calculateRiskPerContract(D(5), new Decimal(Infinity), D(0), D(0)),
    ).toThrow(RiskEngineError);
  });
});

describe("calculatePositionSize", () => {
  it("floors riskBudget / riskPerContract", () => {
    expect(calculatePositionSize(D(1000), D(300))).toBe(3);
  });

  it("returns exactly 0 (not an error) when the floored result is 0", () => {
    expect(calculatePositionSize(D(100), D(300))).toBe(0);
  });

  it("returns 0 when riskBudget is 0", () => {
    expect(calculatePositionSize(D(0), D(300))).toBe(0);
  });

  it("throws when riskPerContract is zero or negative", () => {
    expect(() => calculatePositionSize(D(1000), D(0))).toThrow(RiskEngineError);
    expect(() => calculatePositionSize(D(1000), D(-300))).toThrow(RiskEngineError);
  });

  it("throws when riskBudget is negative", () => {
    expect(() => calculatePositionSize(D(-1000), D(300))).toThrow(RiskEngineError);
  });

  it("throws on NaN/Infinity input", () => {
    expect(() => calculatePositionSize(new Decimal(NaN), D(300))).toThrow(RiskEngineError);
    expect(() => calculatePositionSize(D(1000), new Decimal(Infinity))).toThrow(RiskEngineError);
  });
});

describe("calculateRiskReward", () => {
  it("computes a sign-aware ratio for LONG (target > entry > stop)", () => {
    // risk = 100-95 = 5, reward = 110-100 = 10 -> RR = 2
    expect(calculateRiskReward(D(100), D(95), D(110)).toString()).toBe("2");
  });

  it("computes a sign-aware ratio for SHORT (target < entry < stop)", () => {
    // risk = 100-105 = -5, reward = 90-100 = -10 -> RR = 2
    expect(calculateRiskReward(D(100), D(105), D(90)).toString()).toBe("2");
  });

  it("throws when entry equals stop (zero risk distance)", () => {
    expect(() => calculateRiskReward(D(100), D(100), D(110))).toThrow(RiskEngineError);
  });

  it("throws when target is on the wrong side of entry for a LONG", () => {
    // LONG (stop below entry) but target also below entry -> invalid
    expect(() => calculateRiskReward(D(100), D(95), D(90))).toThrow(RiskEngineError);
  });

  it("throws when target is on the wrong side of entry for a SHORT", () => {
    // SHORT (stop above entry) but target also above entry -> invalid
    expect(() => calculateRiskReward(D(100), D(105), D(110))).toThrow(RiskEngineError);
  });

  it("throws when target equals entry (zero reward)", () => {
    expect(() => calculateRiskReward(D(100), D(95), D(100))).toThrow(RiskEngineError);
  });

  it("throws on NaN/Infinity input", () => {
    expect(() => calculateRiskReward(new Decimal(NaN), D(95), D(110))).toThrow(RiskEngineError);
    expect(() => calculateRiskReward(D(100), D(95), new Decimal(Infinity))).toThrow(
      RiskEngineError,
    );
  });
});

describe("calculateGrossPnl", () => {
  it("computes a positive gross P&L for a winning LONG", () => {
    // (105-100) * 50 * 2 = 500
    expect(calculateGrossPnl(D(100), D(105), 2, D(50), "LONG").toString()).toBe("500");
  });

  it("computes a negative gross P&L for a losing LONG", () => {
    expect(calculateGrossPnl(D(100), D(95), 2, D(50), "LONG").toString()).toBe("-500");
  });

  it("computes a positive gross P&L for a winning SHORT", () => {
    // (100-95) * 50 * 2 = 500
    expect(calculateGrossPnl(D(100), D(95), 2, D(50), "SHORT").toString()).toBe("500");
  });

  it("computes a negative gross P&L for a losing SHORT", () => {
    expect(calculateGrossPnl(D(100), D(105), 2, D(50), "SHORT").toString()).toBe("-500");
  });

  it("throws on a zero or non-integer quantity", () => {
    expect(() => calculateGrossPnl(D(100), D(105), 0, D(50), "LONG")).toThrow(RiskEngineError);
    expect(() => calculateGrossPnl(D(100), D(105), 1.5, D(50), "LONG")).toThrow(RiskEngineError);
  });

  it("throws on a non-positive pointValue", () => {
    expect(() => calculateGrossPnl(D(100), D(105), 1, D(0), "LONG")).toThrow(RiskEngineError);
  });

  it("throws on NaN/Infinity prices", () => {
    expect(() => calculateGrossPnl(new Decimal(NaN), D(105), 1, D(50), "LONG")).toThrow(
      RiskEngineError,
    );
  });
});

describe("calculateNetPnl", () => {
  it("subtracts fees from gross P&L", () => {
    expect(calculateNetPnl(D(500), D(10)).toString()).toBe("490");
  });

  it("allows a negative net P&L", () => {
    expect(calculateNetPnl(D(-500), D(10)).toString()).toBe("-510");
  });

  it("throws on negative fees", () => {
    expect(() => calculateNetPnl(D(500), D(-1))).toThrow(RiskEngineError);
  });
});

describe("calculateRMultiple", () => {
  it("computes a positive R multiple for a winner", () => {
    expect(calculateRMultiple(D(500), D(250)).toString()).toBe("2");
  });

  it("computes a negative R multiple for a loser", () => {
    expect(calculateRMultiple(D(-250), D(250)).toString()).toBe("-1");
  });

  it("throws on a zero or negative riskAmount", () => {
    expect(() => calculateRMultiple(D(500), D(0))).toThrow(RiskEngineError);
    expect(() => calculateRMultiple(D(500), D(-1))).toThrow(RiskEngineError);
  });
});
