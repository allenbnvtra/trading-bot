import { z } from "zod";
import { ASSET_CLASSES } from "./enums";

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
  tickSize: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "tickSize must be a positive decimal string"),
  tickValue: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "tickValue must be a positive decimal string"),
  pointValue: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "pointValue must be a positive decimal string"),
  commissionPerContract: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "commissionPerContract must be a non-negative decimal string"),
  timezone: z.string().trim().min(1).max(64),
  sessionConfiguration: z.record(z.string(), z.unknown()).default({}),
});

export type CreateInstrumentInput = z.infer<typeof createInstrumentSchema>;
