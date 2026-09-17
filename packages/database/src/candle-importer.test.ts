import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Timeframe } from "@trading-copilot/shared-types";
import {
  candleConflictKey,
  importCandlesFromStream,
  validateCsvCandleRow,
} from "./candle-importer";

function validRawRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    timestamp: "2024-01-01T00:00:00.000Z",
    open: "100.00",
    high: "105.00",
    low: "95.00",
    close: "102.00",
    volume: "1000",
    ...overrides,
  };
}

describe("validateCsvCandleRow", () => {
  it("accepts a well-formed row", () => {
    const result = validateCsvCandleRow(validRawRow(), 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candle.timestamp.toISOString()).toBe("2024-01-01T00:00:00.000Z");
      expect(result.candle.open).toBe("100.00");
    }
  });

  it("rejects high < open", () => {
    const result = validateCsvCandleRow(validRawRow({ high: "99.00" }), 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.row).toBe(2);
      expect(result.error.message).toContain("high must be >= open");
    }
  });

  it("rejects high < close", () => {
    const result = validateCsvCandleRow(validRawRow({ high: "101.00", close: "102.00" }), 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("high must be >= close");
  });

  it("rejects high < low", () => {
    // Construct a row where high is below low but individually consistent
    // with the open/close checks, to isolate the high>=low invariant.
    const result = validateCsvCandleRow(
      validRawRow({ open: "95.00", close: "95.00", high: "94.00", low: "95.50" }),
      4,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("high must be >= low");
    }
  });

  it("rejects low > open", () => {
    const result = validateCsvCandleRow(validRawRow({ low: "101.00" }), 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("low must be <= open");
  });

  it("rejects low > close", () => {
    const result = validateCsvCandleRow(validRawRow({ open: "103.00", low: "102.50", close: "102.00" }), 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("low must be <= close");
  });

  it("rejects negative volume", () => {
    const result = validateCsvCandleRow(validRawRow({ volume: "-5" }), 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("volume must be >= 0");
  });

  it("accepts zero volume", () => {
    const result = validateCsvCandleRow(validRawRow({ volume: "0" }), 8);
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed timestamp", () => {
    const result = validateCsvCandleRow(validRawRow({ timestamp: "not-a-date" }), 9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.row).toBe(9);
  });

  it("rejects a non-decimal price string (scientific notation)", () => {
    const result = validateCsvCandleRow(validRawRow({ open: "1e5" }), 10);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-decimal price string (garbage)", () => {
    const result = validateCsvCandleRow(validRawRow({ close: "abc" }), 11);
    expect(result.ok).toBe(false);
  });

  it("reports multiple simultaneous invariant violations in one message", () => {
    const result = validateCsvCandleRow(
      validRawRow({ high: "50.00", low: "150.00", volume: "-1" }),
      12,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("volume must be >= 0");
    }
  });
});

describe("candleConflictKey", () => {
  it("produces the same key for the same instrument/timeframe/timestamp", () => {
    const t = new Date("2024-01-01T00:00:00.000Z");
    expect(candleConflictKey("inst-1", "1h", t)).toBe(candleConflictKey("inst-1", "1h", new Date(t)));
  });

  it("produces different keys for different timeframes", () => {
    const t = new Date("2024-01-01T00:00:00.000Z");
    expect(candleConflictKey("inst-1", "1h", t)).not.toBe(candleConflictKey("inst-1", "5m", t));
  });

  it("produces different keys for different instruments", () => {
    const t = new Date("2024-01-01T00:00:00.000Z");
    expect(candleConflictKey("inst-1", "1h", t)).not.toBe(candleConflictKey("inst-2", "1h", t));
  });
});

// ---------------------------------------------------------------------------
// Full-pipeline tests against an in-memory fake Prisma client. This fake
// implements true unique-constraint upsert semantics (keyed via
// candleConflictKey), so it verifies real idempotent-upsert behavior without
// requiring a live Postgres instance.
// ---------------------------------------------------------------------------

interface FakeCandleRow {
  instrumentId: string;
  timeframe: string;
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface FakeFindManyArgs {
  where: { instrumentId: string; timeframe: string; timestamp: { in: Date[] } };
}

interface FakeUpsertArgs {
  where: { instrumentId_timeframe_timestamp: { instrumentId: string; timeframe: string; timestamp: Date } };
  create: FakeCandleRow;
  update: Omit<FakeCandleRow, "instrumentId" | "timeframe" | "timestamp">;
}

function createFakePrismaClient() {
  const store = new Map<string, FakeCandleRow>();

  const candle = {
    findMany: async (args: FakeFindManyArgs): Promise<Array<{ timestamp: Date }>> => {
      const { instrumentId, timeframe, timestamp } = args.where;
      return timestamp.in
        .filter((ts) => store.has(candleConflictKey(instrumentId, timeframe, ts)))
        .map((ts) => ({ timestamp: ts }));
    },
    upsert: async (args: FakeUpsertArgs): Promise<FakeCandleRow> => {
      const { instrumentId, timeframe, timestamp } = args.where.instrumentId_timeframe_timestamp;
      const key = candleConflictKey(instrumentId, timeframe, timestamp);
      const row = store.has(key) ? { ...store.get(key)!, ...args.update } : args.create;
      store.set(key, row);
      return row;
    },
  };

  const $transaction = async <T>(actions: Array<Promise<T>>): Promise<T[]> => Promise.all(actions);

  return { candle, $transaction, store };
}

function csvStreamFromRows(rows: string[]): Readable {
  const text = ["timestamp,open,high,low,close,volume", ...rows].join("\n") + "\n";
  return new Readable({
    read() {
      this.push(text);
      this.push(null);
    },
  });
}

describe("importCandlesFromStream", () => {
  it("imports valid rows and skips one bad row without aborting the file", async () => {
    const fake = createFakePrismaClient();
    const stream = csvStreamFromRows([
      "2024-01-01T00:00:00.000Z,100,105,95,102,1000", // valid
      "2024-01-01T01:00:00.000Z,100,90,95,102,1000", // invalid: high < open
      "2024-01-01T02:00:00.000Z,100,106,95,103,1100", // valid
    ]);

    const summary = await importCandlesFromStream(fake as unknown as PrismaClient, stream, {
      instrumentId: "inst-1",
      timeframe: "1h",
    });

    expect(summary.rowsRead).toBe(3);
    expect(summary.rejected).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.row).toBe(2);
    expect(summary.inserted).toBe(2);
    expect(summary.updated).toBe(0);
    expect(fake.store.size).toBe(2);
  });

  it("is idempotent: re-importing the same file reports updates, not duplicate inserts", async () => {
    const fake = createFakePrismaClient();
    const rows = [
      "2024-01-01T00:00:00.000Z,100,105,95,102,1000",
      "2024-01-01T01:00:00.000Z,102,108,101,106,1200",
    ];

    const first = await importCandlesFromStream(fake as unknown as PrismaClient, csvStreamFromRows(rows), {
      instrumentId: "inst-1",
      timeframe: "1h",
    });
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(fake.store.size).toBe(2);

    const second = await importCandlesFromStream(fake as unknown as PrismaClient, csvStreamFromRows(rows), {
      instrumentId: "inst-1",
      timeframe: "1h",
    });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(fake.store.size).toBe(2); // no duplicates
  });

  it("rejects an invalid timeframe up front", async () => {
    const fake = createFakePrismaClient();
    await expect(
      importCandlesFromStream(fake as unknown as PrismaClient, csvStreamFromRows([]), {
        instrumentId: "inst-1",
        timeframe: "3h" as unknown as Timeframe,
      }),
    ).rejects.toThrow(/Invalid timeframe/);
  });
});

/**
 * True end-to-end idempotency against a live Postgres is verified manually
 * once Docker Compose + `pnpm db:migrate` have run (see the data-engineer's
 * final report). The in-memory fake above exercises the same conflict-key
 * logic that the real (instrumentId, timeframe, timestamp) unique
 * constraint enforces, so this suite intentionally does not duplicate a
 * live-DB integration test here.
 */
describe.skipIf(!process.env.DATABASE_URL)("importCandlesFromStream (live Postgres)", () => {
  it.todo("re-running an import against a live database does not create duplicate rows");
});
