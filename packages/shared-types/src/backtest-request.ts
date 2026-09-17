import { z } from "zod";
import { TIMEFRAMES } from "./enums";

/**
 * Matches a decimal string that is strictly greater than zero. A zero
 * account balance is nonsensical input (as opposed to riskPercentage, where
 * 0 legitimately means "risk nothing" and is left as non-negative below) —
 * reject it here so the API returns a synchronous 400 instead of the
 * backtest silently reaching FAILED later inside packages/risk-engine.
 */
const positiveDecimalString = /^(?!0(?:\.0+)?$)\d+(\.\d+)?$/;

/**
 * Input schema for POST /backtests. Conservative assumptions (commission,
 * slippage) must be supplied explicitly rather than silently defaulted to
 * zero, so every backtest documents what it assumed.
 */
export const createBacktestRequestSchema = z
  .object({
    instrumentId: z.string().uuid(),
    strategyVersionId: z.string().uuid(),
    timeframe: z.enum(TIMEFRAMES),
    startDate: z.string().datetime({ message: "startDate must be ISO-8601 UTC" }),
    endDate: z.string().datetime({ message: "endDate must be ISO-8601 UTC" }),
    initialBalance: z
      .string()
      .trim()
      .regex(positiveDecimalString, "initialBalance must be a positive decimal string (not zero)"),
    riskPercentage: z
      .string()
      .trim()
      .regex(/^\d+(\.\d+)?$/, "riskPercentage must be a non-negative decimal string, e.g. \"1\" for 1%"),
    slippageTicks: z.number().int().min(0).default(0),
  })
  .refine((value) => new Date(value.startDate).getTime() < new Date(value.endDate).getTime(), {
    message: "startDate must be strictly before endDate",
    path: ["endDate"],
  });

export type CreateBacktestRequestInput = z.infer<typeof createBacktestRequestSchema>;
