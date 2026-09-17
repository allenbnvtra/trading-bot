import { describe, expect, it } from "vitest";
import { csvCandleRowSchema } from "./csv-candle";

const validRow = {
  timestamp: "2024-01-01T00:00:00.000Z",
  open: "100.5",
  high: "101.25",
  low: "99.75",
  close: "100.9",
  volume: "1234.5",
};

describe("csvCandleRowSchema", () => {
  it("accepts a well-formed row", () => {
    const result = csvCandleRowSchema.safeParse(validRow);
    expect(result.success).toBe(true);
  });

  it("rejects a non-ISO timestamp", () => {
    const result = csvCandleRowSchema.safeParse({ ...validRow, timestamp: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects scientific notation in a price field", () => {
    const result = csvCandleRowSchema.safeParse({ ...validRow, open: "1e5" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric price field", () => {
    const result = csvCandleRowSchema.safeParse({ ...validRow, close: "abc" });
    expect(result.success).toBe(false);
  });

  it("accepts a negative price string (schema does not enforce sign; candle invariants do)", () => {
    // Negative prices are nonsensical for OHLC candles, but that invariant is
    // enforced by packages/database's candle-importer, not this schema — this
    // schema only guarantees "a plain decimal number string".
    const result = csvCandleRowSchema.safeParse({ ...validRow, volume: "-1" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing field", () => {
    const { volume: _volume, ...withoutVolume } = validRow;
    const result = csvCandleRowSchema.safeParse(withoutVolume);
    expect(result.success).toBe(false);
  });
});
