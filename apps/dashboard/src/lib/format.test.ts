import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatDecimal,
  formatInteger,
  formatPercent,
  formatPercentValue,
  formatProfitFactor,
  formatR,
  signOf,
} from "./format";

describe("format", () => {
  it("formats decimals with thousands separators and fixed precision", () => {
    expect(formatDecimal("1234.5", 2)).toBe("1,234.50");
    expect(formatDecimal(null, 2)).toBe("N/A");
    expect(formatDecimal(undefined, 2)).toBe("N/A");
  });

  it("formats currency preserving sign", () => {
    expect(formatCurrency("-361.8370941")).toBe("-$361.84");
    expect(formatCurrency("681.4453932")).toBe("$681.45");
  });

  it("formats a 0-1 fraction as a percentage", () => {
    expect(formatPercent("0.181818", 1)).toBe("18.2%");
  });

  it("formats a value already in percent units", () => {
    expect(formatPercentValue("11.71361447", 1)).toBe("11.7%");
  });

  it("never renders a null profit factor as 0 or Infinity", () => {
    expect(formatProfitFactor(null)).toBe("N/A");
    expect(formatProfitFactor("0.41930075")).toBe("0.42");
  });

  it("formats R multiples with an R suffix", () => {
    expect(formatR("-0.48580674", 2)).toBe("-0.49R");
  });

  it("formats integers with thousands separators", () => {
    expect(formatInteger(33)).toBe("33");
    expect(formatInteger(null)).toBe("N/A");
  });

  it("classifies the sign of an already-computed value for styling", () => {
    expect(signOf("681.44")).toBe("positive");
    expect(signOf("-398.71")).toBe("negative");
    expect(signOf("0")).toBe("neutral");
    expect(signOf(null)).toBe("neutral");
  });
});
