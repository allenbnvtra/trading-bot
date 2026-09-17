import { z } from "zod";
import { analyticsQuerySchema } from "@trading-copilot/shared-types";

/**
 * Mirrors packages/analytics' GroupByField union exactly. Kept as a local
 * literal list (rather than importing GroupByField as a value) since it's a
 * type-only export there; validated against here so an invalid groupBy
 * value is a 400, never silently ignored or passed through to
 * groupTradeAnalytics (which throws a plain Error on an empty array, not a
 * validated 400).
 */
const GROUP_BY_FIELDS = [
  "strategyId",
  "strategyVersionId",
  "instrumentId",
  "direction",
  "executionMode",
] as const;

export const analyticsComparisonQuerySchema = analyticsQuerySchema.extend({
  groupBy: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((field) => field.trim())
            .filter((field) => field.length > 0)
        : undefined,
    )
    .refine(
      (fields) =>
        fields === undefined ||
        fields.every((field) => (GROUP_BY_FIELDS as readonly string[]).includes(field)),
      { message: `groupBy must be a comma-separated list of: ${GROUP_BY_FIELDS.join(", ")}` },
    ),
});
export type AnalyticsComparisonQuery = z.infer<typeof analyticsComparisonQuerySchema>;
