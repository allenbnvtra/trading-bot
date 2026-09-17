import { z } from "zod";

/**
 * A decimal-safe numeric string: digits, optional single decimal point,
 * optional leading minus. Rejects NaN/Infinity spellings, scientific
 * notation, and anything else that would be unsafe to hand to Decimal().
 */
const decimalStringSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, "must be a plain decimal number (no scientific notation)");

/**
 * Raw CSV row schema for candle import, matching the documented format:
 * timestamp,open,high,low,close,volume
 *
 * All numeric fields arrive as strings from the CSV parser; they are kept as
 * strings here (never parsed to `number`) so callers can hand them straight
 * to Decimal without floating-point round-tripping.
 */
export const csvCandleRowSchema = z.object({
  timestamp: z.string().trim().datetime({ message: "timestamp must be ISO-8601 UTC" }),
  open: decimalStringSchema,
  high: decimalStringSchema,
  low: decimalStringSchema,
  close: decimalStringSchema,
  volume: decimalStringSchema,
});

export type CsvCandleRow = z.infer<typeof csvCandleRowSchema>;

export const CSV_CANDLE_HEADER = ["timestamp", "open", "high", "low", "close", "volume"] as const;
