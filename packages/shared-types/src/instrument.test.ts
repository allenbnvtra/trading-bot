import { describe, expect, it } from "vitest";
import { createInstrumentSchema } from "./instrument";

const validInstrument = {
  symbol: "GENERIC-FUT",
  name: "Generic Index Future",
  assetClass: "FUTURES" as const,
  exchange: "GENX",
  currency: "USD",
  tickSize: "0.25",
  tickValue: "5",
  pointValue: "20",
  commissionPerContract: "2.5",
  timezone: "America/New_York",
  sessionConfiguration: {},
};

describe("createInstrumentSchema", () => {
  it("accepts a well-formed instrument", () => {
    expect(createInstrumentSchema.safeParse(validInstrument).success).toBe(true);
  });

  it("rejects an invalid assetClass", () => {
    const result = createInstrumentSchema.safeParse({ ...validInstrument, assetClass: "OPTION" });
    expect(result.success).toBe(false);
  });

  it("rejects a currency that is not 3 characters", () => {
    const result = createInstrumentSchema.safeParse({ ...validInstrument, currency: "US" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-decimal tickSize", () => {
    const result = createInstrumentSchema.safeParse({ ...validInstrument, tickSize: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects a zero tickSize, tickValue, or pointValue", () => {
    expect(createInstrumentSchema.safeParse({ ...validInstrument, tickSize: "0" }).success).toBe(false);
    expect(createInstrumentSchema.safeParse({ ...validInstrument, tickValue: "0" }).success).toBe(false);
    expect(createInstrumentSchema.safeParse({ ...validInstrument, pointValue: "0.00" }).success).toBe(false);
  });

  it("accepts a zero commissionPerContract (legitimately commission-free)", () => {
    const result = createInstrumentSchema.safeParse({ ...validInstrument, commissionPerContract: "0" });
    expect(result.success).toBe(true);
  });

  it("defaults sessionConfiguration to an empty object when omitted", () => {
    const { sessionConfiguration: _sessionConfiguration, ...withoutSession } = validInstrument;
    const result = createInstrumentSchema.safeParse(withoutSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionConfiguration).toEqual({});
    }
  });
});
