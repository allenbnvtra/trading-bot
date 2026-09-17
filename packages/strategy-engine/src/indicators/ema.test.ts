import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateEma } from "./ema";

const D = (value: string | number) => new Decimal(value);
const toStrings = (values: Array<Decimal | null>) =>
  values.map((v) => (v === null ? null : v.toString()));

describe("calculateEma", () => {
  it("computes a hand-verified EMA(3) over [1,2,3,4,5,6]", () => {
    // seed at index 2 = avg(1,2,3) = 2; multiplier = 2/4 = 0.5
    // idx3 = (4-2)*0.5+2 = 3
    // idx4 = (5-3)*0.5+3 = 4
    // idx5 = (6-4)*0.5+4 = 5
    const values = [1, 2, 3, 4, 5, 6].map(D);
    const result = calculateEma(values, 3);
    expect(toStrings(result)).toEqual([null, null, "2", "3", "4", "5"]);
  });

  it("computes a hand-verified EMA(2) over [10,12,11,15]", () => {
    // seed at index1 = avg(10,12) = 11; multiplier = 2/3
    // idx2 = (11-11)*(2/3)+11 = 11
    // idx3 = (15-11)*(2/3)+11 = 11 + 8/3 = 13.6666...
    const values = [10, 12, 11, 15].map(D);
    const result = calculateEma(values, 2);
    expect(result[0]).toBeNull();
    expect((result[1] as Decimal).toString()).toBe("11");
    expect((result[2] as Decimal).toString()).toBe("11");
    expect((result[3] as Decimal).toFixed(6)).toBe("13.666667");
  });

  it("returns null for every index before the seed index and a real value from the seed index onward", () => {
    const values = [1, 2, 3, 4, 5].map(D);
    const result = calculateEma(values, 4);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
    expect(result[3]).not.toBeNull();
    expect(result[4]).not.toBeNull();
  });

  it("returns all nulls when values.length < period (still warming up)", () => {
    const values = [1, 2, 3].map(D);
    const result = calculateEma(values, 5);
    expect(result).toEqual([null, null, null]);
  });

  it("output length always equals input length", () => {
    const values = [1, 2, 3, 4, 5, 6, 7].map(D);
    expect(calculateEma(values, 3)).toHaveLength(values.length);
  });

  it("throws when period is 0", () => {
    expect(() => calculateEma([D(1)], 0)).toThrow();
  });

  it("throws when period is negative", () => {
    expect(() => calculateEma([D(1)], -1)).toThrow();
  });

  it("throws when period is not an integer", () => {
    expect(() => calculateEma([D(1)], 2.5)).toThrow();
  });

  it("throws when values is empty", () => {
    expect(() => calculateEma([], 3)).toThrow();
  });
});
