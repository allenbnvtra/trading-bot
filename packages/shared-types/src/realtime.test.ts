import { describe, expect, it } from "vitest";
import { parseRealtimeEvent } from "./realtime";

describe("parseRealtimeEvent", () => {
  it("parses a valid webhook.received event", () => {
    const raw = JSON.stringify({
      type: "webhook.received",
      timestamp: "2026-09-18T01:30:02.000Z",
      webhookEventId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      provider: "TRADINGVIEW",
    });
    const parsed = parseRealtimeEvent(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("webhook.received");
  });

  it("parses a valid setup.created event", () => {
    const raw = JSON.stringify({
      type: "setup.created",
      timestamp: "2026-09-18T01:30:02.000Z",
      setupId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      instrumentId: "3fa85f64-5717-4562-b3fc-2c963f66afa7",
      status: "WATCH",
      direction: "LONG",
    });
    const parsed = parseRealtimeEvent(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("setup.created");
  });

  it("returns null for invalid JSON, never throwing", () => {
    expect(parseRealtimeEvent("{not json")).toBeNull();
  });

  it("returns null for well-formed JSON that doesn't match any event shape", () => {
    expect(parseRealtimeEvent(JSON.stringify({ type: "unknown.event" }))).toBeNull();
  });

  it("returns null for a setup event missing required fields", () => {
    expect(
      parseRealtimeEvent(JSON.stringify({ type: "setup.created", timestamp: "2026-09-18T01:30:02.000Z" })),
    ).toBeNull();
  });
});
