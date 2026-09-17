import { z } from "zod";
import { ASSET_CLASSES } from "./enums";

/**
 * Matches a decimal string that is strictly greater than zero (e.g. "0.25",
 * "12", but not "0" or "0.0"). Used for fields that risk-engine divides by
 * or multiplies against, where zero would be silently useless or, further
 * downstream, a divide-by-zero — reject it here at the API boundary instead
 * of letting it surface later as an async backtest failure.
 */
const positiveDecimalString = /^(?!0(?:\.0+)?$)\d+(\.\d+)?$/;

/** Matches a decimal string that is zero or greater (e.g. commissions, which may legitimately be free). */
const nonNegativeDecimalString = /^\d+(\.\d+)?$/;

/**
 * Input schema for creating an Instrument. Deliberately generic — no real
 * contract specs (NQ/ES/BTC/etc.) are hardcoded anywhere in the engine.
 * Development fixtures live in packages/database/prisma/seed.ts instead.
 */
export const createInstrumentSchema = z.object({
  symbol: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(128),
  assetClass: z.enum(ASSET_CLASSES),
  exchange: z.string().trim().min(1).max(64),
  currency: z.string().trim().length(3),
  tickSize: z.string().trim().regex(positiveDecimalString, "tickSize must be a positive decimal string (not zero)"),
  tickValue: z
    .string()
    .trim()
    .regex(positiveDecimalString, "tickValue must be a positive decimal string (not zero)"),
  pointValue: z
    .string()
    .trim()
    .regex(positiveDecimalString, "pointValue must be a positive decimal string (not zero)"),
  commissionPerContract: z
    .string()
    .trim()
    .regex(nonNegativeDecimalString, "commissionPerContract must be a non-negative decimal string"),
  timezone: z.string().trim().min(1).max(64),
  sessionConfiguration: z.record(z.string(), z.unknown()).default({}),
});

export type CreateInstrumentInput = z.infer<typeof createInstrumentSchema>;
