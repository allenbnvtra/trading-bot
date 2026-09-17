import { z } from "zod";
import { TIMEFRAMES } from "./enums";

/**
 * Input schema for POST /backtests. Conservative assumptions (commission,
 * slippage) must be supplied explicitly rather than silently defaulted to
 * zero, so every backtest documents what it assumed.
 */
export const createBacktestRequestSchema = z.object({
  instrumentId: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
  startDate: z.string().datetime({ message: "startDate must be ISO-8601 UTC" }),
  endDate: z.string().datetime({ message: "endDate must be ISO-8601 UTC" }),
  initialBalance: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "initialBalance must be a positive decimal string"),
  riskPercentage: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "riskPercentage must be a decimal string, e.g. \"1\" for 1%"),
  slippageTicks: z.number().int().min(0).default(0),
});

export type CreateBacktestRequestInput = z.infer<typeof createBacktestRequestSchema>;
