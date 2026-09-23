import { describe, expect, it, vi } from "vitest";
import { prisma } from "../client";
import { getCandlesUpToTimestamp } from "./candles";

vi.mock("../client", () => ({
  prisma: { candle: { findMany: vi.fn() } },
}));

function candleRow(timestamp: string) {
  return {
    id: `candle-${timestamp}`,
    instrumentId: "instrument-1",
    timeframe: "5m",
    timestamp: new Date(timestamp),
    open: "1", high: "1", low: "1", close: "1", volume: "1",
  };
}

describe("getCandlesUpToTimestamp", () => {
  it("queries with timestamp <= cutoff, descending, limited to count, then returns ascending", async () => {
    const cutoff = new Date("2026-09-18T01:30:00.000Z");
    vi.mocked(prisma.candle.findMany).mockResolvedValue([
      candleRow("2026-09-18T01:30:00.000Z"),
      candleRow("2026-09-18T01:25:00.000Z"),
    ] as never);

    const result = await getCandlesUpToTimestamp("instrument-1", "5m", cutoff, 150);

    expect(prisma.candle.findMany).toHaveBeenCalledWith({
      where: { instrumentId: "instrument-1", timeframe: "5m", timestamp: { lte: cutoff } },
      orderBy: { timestamp: "desc" },
      take: 150,
    });
    // Returned in ascending order (oldest first), matching getCandles'
    // existing convention — never left in the query's descending order.
    expect(result.map((c) => c.timestamp.toISOString())).toEqual([
      "2026-09-18T01:25:00.000Z",
      "2026-09-18T01:30:00.000Z",
    ]);
  });

  it("never includes a candle after the cutoff — the WHERE clause, not client-side filtering, is what excludes it", async () => {
    // This test proves the *call site* asks Postgres to exclude the future
    // candle (via `lte`); it does not and cannot prove Postgres itself
    // enforces `<=` (that is proven by the integration test in Task 2a),
    // but a regression that changed `lte` to `lt`/removed the clause/passed
    // the wrong cutoff would fail this assertion immediately.
    const cutoff = new Date("2026-09-18T01:30:00.000Z");
    vi.mocked(prisma.candle.findMany).mockResolvedValue([]);

    await getCandlesUpToTimestamp("instrument-1", "5m", cutoff, 150);

    const callArgs = vi.mocked(prisma.candle.findMany).mock.calls[0]![0]!;
    expect(callArgs.where!.timestamp).toEqual({ lte: cutoff });
  });

  it("returns fewer than `count` candles when fewer exist, never an error", async () => {
    vi.mocked(prisma.candle.findMany).mockResolvedValue([candleRow("2026-09-18T01:30:00.000Z")] as never);
    const result = await getCandlesUpToTimestamp("instrument-1", "5m", new Date(), 150);
    expect(result).toHaveLength(1);
  });

  it("returns an empty array when no candles exist at or before the cutoff", async () => {
    vi.mocked(prisma.candle.findMany).mockResolvedValue([]);
    const result = await getCandlesUpToTimestamp("instrument-1", "5m", new Date(), 150);
    expect(result).toEqual([]);
  });
});
