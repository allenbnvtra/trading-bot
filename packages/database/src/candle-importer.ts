import type { Readable } from "node:stream";
import { parse } from "csv-parse";
import { Decimal } from "decimal.js";
import { csvCandleRowSchema, TIMEFRAMES, type Timeframe } from "@trading-copilot/shared-types";
import type { PrismaClient } from "@prisma/client";

/**
 * Streaming CSV candle importer.
 *
 * - Streams rows via csv-parse rather than buffering the whole file.
 * - Validates every row (schema shape, then candle invariants) before
 *   insert; a bad row is recorded in `errors` and skipped — one malformed
 *   row never aborts the rest of the file.
 * - Valid rows are upserted in batches keyed on the
 *   (instrumentId, timeframe, timestamp) unique constraint, so re-running
 *   an import with overlapping data is idempotent (no duplicates, no error).
 */

export interface CandleImportError {
  row: number;
  message: string;
}

export interface CandleImportSummary {
  instrumentId: string;
  timeframe: Timeframe;
  rowsRead: number;
  inserted: number;
  updated: number;
  rejected: number;
  errors: CandleImportError[];
}

export interface NormalizedCandleRow {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

type RowValidationResult =
  | { ok: true; candle: NormalizedCandleRow }
  | { ok: false; error: CandleImportError };

/**
 * Pure row validation: CSV schema shape (via csvCandleRowSchema) plus
 * candle invariants (high >= open/close/low, low <= open/close, volume >= 0).
 * Exported so it is unit-testable without Prisma or a database — see
 * src/candle-importer.test.ts.
 */
export function validateCsvCandleRow(
  rawRow: Record<string, string>,
  rowNumber: number,
): RowValidationResult {
  const parsed = csvCandleRowSchema.safeParse(rawRow);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: { row: rowNumber, message } };
  }

  const { timestamp, open, high, low, close, volume } = parsed.data;
  const openD = new Decimal(open);
  const highD = new Decimal(high);
  const lowD = new Decimal(low);
  const closeD = new Decimal(close);
  const volumeD = new Decimal(volume);

  const invariantErrors: string[] = [];
  if (highD.lt(openD)) invariantErrors.push("high must be >= open");
  if (highD.lt(closeD)) invariantErrors.push("high must be >= close");
  if (highD.lt(lowD)) invariantErrors.push("high must be >= low");
  if (lowD.gt(openD)) invariantErrors.push("low must be <= open");
  if (lowD.gt(closeD)) invariantErrors.push("low must be <= close");
  if (volumeD.lt(0)) invariantErrors.push("volume must be >= 0");

  if (invariantErrors.length > 0) {
    return { ok: false, error: { row: rowNumber, message: invariantErrors.join("; ") } };
  }

  return {
    ok: true,
    candle: { timestamp: new Date(timestamp), open, high, low, close, volume },
  };
}

/**
 * Composite conflict key for the (instrumentId, timeframe, timestamp)
 * unique constraint. Factored out as a pure function so "same key -> one
 * upsert, not a duplicate row" idempotency logic can be unit tested without
 * a live database — see src/candle-importer.test.ts.
 */
export function candleConflictKey(instrumentId: string, timeframe: string, timestamp: Date): string {
  return `${instrumentId}::${timeframe}::${timestamp.toISOString()}`;
}

const BATCH_SIZE = 500;

export interface ImportCandlesParams {
  instrumentId: string;
  timeframe: Timeframe;
}

export async function importCandlesFromStream(
  prisma: PrismaClient,
  input: Readable,
  params: ImportCandlesParams,
): Promise<CandleImportSummary> {
  const { instrumentId, timeframe } = params;

  if (!(TIMEFRAMES as readonly string[]).includes(timeframe)) {
    throw new Error(`Invalid timeframe "${timeframe}". Must be one of: ${TIMEFRAMES.join(", ")}`);
  }

  const summary: CandleImportSummary = {
    instrumentId,
    timeframe,
    rowsRead: 0,
    inserted: 0,
    updated: 0,
    rejected: 0,
    errors: [],
  };

  const parser = input.pipe(
    parse({
      columns: true,
      trim: true,
      skip_empty_lines: true,
    }),
  );

  let batch: NormalizedCandleRow[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const currentBatch = batch;
    batch = [];

    const timestamps = currentBatch.map((row) => row.timestamp);
    const existing = await prisma.candle.findMany({
      where: { instrumentId, timeframe, timestamp: { in: timestamps } },
      select: { timestamp: true },
    });
    const existingKeys = new Set(existing.map((row) => row.timestamp.getTime()));

    for (const row of currentBatch) {
      if (existingKeys.has(row.timestamp.getTime())) {
        summary.updated += 1;
      } else {
        summary.inserted += 1;
      }
    }

    await prisma.$transaction(
      currentBatch.map((row) =>
        prisma.candle.upsert({
          where: {
            instrumentId_timeframe_timestamp: {
              instrumentId,
              timeframe,
              timestamp: row.timestamp,
            },
          },
          create: {
            instrumentId,
            timeframe,
            timestamp: row.timestamp,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
          },
          update: {
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
          },
        }),
      ),
    );
  };

  let rowNumber = 0;
  for await (const rawRow of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;
    summary.rowsRead += 1;

    const result = validateCsvCandleRow(rawRow, rowNumber);
    if (!result.ok) {
      summary.rejected += 1;
      summary.errors.push(result.error);
      continue;
    }

    batch.push(result.candle);
    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
  }

  await flush();

  return summary;
}
