import { z } from "zod";
import { TIMEFRAMES } from "@trading-copilot/shared-types";

/**
 * Small inline query schema, following the market-data.controller.ts
 * precedent (Milestone 1) for endpoints that don't otherwise need a
 * shared-types DTO.
 */
export const marketSnapshotListQuerySchema = z.object({
  instrumentId: z.string().uuid().optional(),
  timeframe: z.enum(TIMEFRAMES).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type MarketSnapshotListQuery = z.infer<typeof marketSnapshotListQuerySchema>;
