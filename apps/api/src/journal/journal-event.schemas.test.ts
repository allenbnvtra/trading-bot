import { describe, expect, it } from "vitest";
import { journalEventListQuerySchema } from "./journal-event.schemas";

describe("journalEventListQuerySchema", () => {
  it("allows an empty query", () => {
    expect(journalEventListQuerySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a well-formed filter set", () => {
    const result = journalEventListQuerySchema.safeParse({
      entityType: "SETUP",
      entityId: "11111111-1111-1111-1111-111111111111",
      correlationId: "11111111-1111-1111-1111-111111111111",
      dateFrom: "2024-01-01T00:00:00.000Z",
      dateTo: "2024-02-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid entityType", () => {
    const result = journalEventListQuerySchema.safeParse({ entityType: "NOT_A_TYPE" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid entityId", () => {
    const result = journalEventListQuerySchema.safeParse({ entityId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});
