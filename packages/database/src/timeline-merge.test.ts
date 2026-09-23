import { describe, expect, it } from "vitest";
import { mergeJournalEventRows } from "./repositories/journal-events";

function row(id: string, sequence: number, timestampMs: number) {
  return {
    id,
    eventType: "SETUP_CREATED" as const,
    timestamp: new Date(timestampMs),
    sequence,
    entityType: "SETUP" as const,
    entityId: "setup-1",
    correlationId: "corr-1",
    instrumentId: null,
    strategyId: null,
    strategyVersionId: null,
    metadata: {},
  };
}

describe("mergeJournalEventRows", () => {
  it("orders by timestamp first", () => {
    const a = [row("a", 5, 2000)];
    const b = [row("b", 1, 1000)];
    expect(mergeJournalEventRows(a, b).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("breaks a timestamp tie using sequence, not array concatenation order", () => {
    // Deliberately construct the case JS's stable sort would get "right" by
    // accident if b were concatenated first — put the later-sequence event
    // in the first array to prove sequence, not position, decides order.
    const a = [row("later", 9, 1000)];
    const b = [row("earlier", 3, 1000)];
    expect(mergeJournalEventRows(a, b).map((r) => r.id)).toEqual(["earlier", "later"]);
  });
});
