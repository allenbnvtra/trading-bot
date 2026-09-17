import { z } from "zod";
import { JOURNAL_ENTITY_TYPES } from "@trading-copilot/shared-types";

/**
 * Read-only query schema for GET /journal/events. There is deliberately no
 * corresponding "create" schema/endpoint — journal events are only ever
 * emitted as a side effect of setupsRepository/journalTradesRepository/
 * riskCalculationsRepository/postTradeAnalysesRepository calls (see
 * packages/database), never fabricated directly by a client.
 */
export const journalEventListQuerySchema = z.object({
  entityType: z.enum(JOURNAL_ENTITY_TYPES).optional(),
  entityId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  instrumentId: z.string().uuid().optional(),
  strategyId: z.string().uuid().optional(),
  strategyVersionId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type JournalEventListQuery = z.infer<typeof journalEventListQuerySchema>;
