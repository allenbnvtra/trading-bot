import { describe, expect, it } from "vitest";
import {
  computeTradingViewFingerprint,
  mapTradingViewTimeframe,
  normalizeTradingViewPayload,
  tradingViewWebhookEnvelopeSchema,
  tradingViewWebhookV1Schema,
} from "./tradingview";

const validV1Payload = {
  schemaVersion: 1 as const,
  source: "TRADINGVIEW" as const,
  strategyKey: "ema-trend-pullback",
  strategyVersion: "1.0.0",
  exchange: "CME",
  symbol: "NQ1!",
  timeframe: "5",
  signal: "SETUP_CANDIDATE",
  direction: "LONG" as const,
  barTime: "2026-09-18T01:30:00.000Z",
  firedAt: "2026-09-18T01:30:01.000Z",
  open: "123.45",
  high: "124.00",
  low: "123.20",
  close: "123.80",
  volume: "1000",
  metadata: {},
};

describe("tradingViewWebhookEnvelopeSchema", () => {
  it("accepts any payload carrying a numeric schemaVersion and TRADINGVIEW source", () => {
    const result = tradingViewWebhookEnvelopeSchema.safeParse({
      schemaVersion: 999,
      source: "TRADINGVIEW",
      whateverFutureField: "abc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with no schemaVersion at all", () => {
    const result = tradingViewWebhookEnvelopeSchema.safeParse({ source: "TRADINGVIEW" });
    expect(result.success).toBe(false);
  });

  it("rejects a source other than TRADINGVIEW", () => {
    const result = tradingViewWebhookEnvelopeSchema.safeParse({ schemaVersion: 1, source: "OTHER" });
    expect(result.success).toBe(false);
  });
});

describe("tradingViewWebhookV1Schema", () => {
  it("accepts a well-formed v1 payload", () => {
    expect(tradingViewWebhookV1Schema.safeParse(validV1Payload).success).toBe(true);
  });

  it("rejects a non-decimal price field", () => {
    const result = tradingViewWebhookV1Schema.safeParse({ ...validV1Payload, close: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects scientific notation in a price field", () => {
    const result = tradingViewWebhookV1Schema.safeParse({ ...validV1Payload, open: "1e5" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid direction", () => {
    const result = tradingViewWebhookV1Schema.safeParse({ ...validV1Payload, direction: "SIDEWAYS" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO barTime", () => {
    const result = tradingViewWebhookV1Schema.safeParse({ ...validV1Payload, barTime: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("defaults metadata to an empty object", () => {
    const { metadata: _metadata, ...withoutMetadata } = validV1Payload;
    const result = tradingViewWebhookV1Schema.safeParse(withoutMetadata);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.metadata).toEqual({});
  });
});

describe("computeTradingViewFingerprint", () => {
  it("produces a 64-character hex SHA-256 digest", () => {
    const fingerprint = computeTradingViewFingerprint(validV1Payload);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    expect(computeTradingViewFingerprint(validV1Payload)).toBe(computeTradingViewFingerprint(validV1Payload));
  });

  it("is unaffected by firedAt (redelivery of the same trigger has a different firedAt)", () => {
    const later = { ...validV1Payload, firedAt: "2026-09-18T01:35:00.000Z" };
    expect(computeTradingViewFingerprint(validV1Payload)).toBe(computeTradingViewFingerprint(later));
  });

  it("is unaffected by OHLCV fields", () => {
    const differentPrice = { ...validV1Payload, close: "999.99" };
    expect(computeTradingViewFingerprint(validV1Payload)).toBe(computeTradingViewFingerprint(differentPrice));
  });

  it("is case- and whitespace-insensitive for identifier fields", () => {
    const messy = { ...validV1Payload, symbol: "  nq1!  ", exchange: "cme" };
    expect(computeTradingViewFingerprint(validV1Payload)).toBe(computeTradingViewFingerprint(messy));
  });

  it("differs when barTime differs (a genuinely different market bar)", () => {
    const differentBar = { ...validV1Payload, barTime: "2026-09-18T01:35:00.000Z" };
    expect(computeTradingViewFingerprint(validV1Payload)).not.toBe(computeTradingViewFingerprint(differentBar));
  });

  it("differs when direction differs", () => {
    const short = { ...validV1Payload, direction: "SHORT" as const };
    expect(computeTradingViewFingerprint(validV1Payload)).not.toBe(computeTradingViewFingerprint(short));
  });

  it("differs when strategyVersion differs", () => {
    const otherVersion = { ...validV1Payload, strategyVersion: "1.1.0" };
    expect(computeTradingViewFingerprint(validV1Payload)).not.toBe(computeTradingViewFingerprint(otherVersion));
  });
});

describe("mapTradingViewTimeframe", () => {
  it.each([
    ["1", "1m"],
    ["5", "5m"],
    ["15", "15m"],
    ["60", "1h"],
    ["240", "4h"],
    ["D", "1d"],
  ])("maps TradingView interval %s to %s", (raw, expected) => {
    expect(mapTradingViewTimeframe(raw)).toBe(expected);
  });

  it("returns null for an unmapped interval rather than guessing", () => {
    expect(mapTradingViewTimeframe("W")).toBeNull();
    expect(mapTradingViewTimeframe("2")).toBeNull();
  });
});

describe("normalizeTradingViewPayload", () => {
  const receivedAt = new Date("2026-09-18T01:30:02.000Z");

  it("normalizes a well-formed payload", () => {
    const result = normalizeTradingViewPayload(validV1Payload, receivedAt);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.timeframe).toBe("5m");
      expect(result.signal.signalType).toBe("SETUP_CANDIDATE");
      expect(result.signal.externalEventFingerprint).toBe(computeTradingViewFingerprint(validV1Payload));
      expect(result.signal.receivedTimestamp).toBe(receivedAt.toISOString());
    }
  });

  it("rejects an unsupported signal type", () => {
    const result = normalizeTradingViewPayload({ ...validV1Payload, signal: "EXIT_SIGNAL" }, receivedAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe("UNSUPPORTED_SIGNAL_TYPE");
  });

  it("rejects an unmappable timeframe", () => {
    const result = normalizeTradingViewPayload({ ...validV1Payload, timeframe: "W" }, receivedAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe("UNSUPPORTED_TIMEFRAME");
  });

  it("rejects a candle where high < open (malformed OHLC)", () => {
    const result = normalizeTradingViewPayload({ ...validV1Payload, high: "100" }, receivedAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe("MALFORMED_PAYLOAD");
  });

  it("rejects a negative volume", () => {
    // volume is already constrained to a non-negative decimal string by the
    // Zod schema at the HTTP boundary; this exercises the normalizer's own
    // defense-in-depth check independent of that.
    const result = normalizeTradingViewPayload({ ...validV1Payload, volume: "-1" }, receivedAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe("MALFORMED_PAYLOAD");
  });
});
