import { z } from "zod";
import { LOSS_CATEGORIES, POST_TRADE_OUTCOMES, TRADE_SOURCES } from "@trading-copilot/shared-types";

/**
 * No shared-types DTO exists yet for PostTradeAnalysis (there was no spec
 * for it ahead of Milestone 2's analysis-mechanism work) — an inline schema
 * here, consistent with market-data.controller.ts's precedent for
 * less-central endpoints. postTradeAnalysesRepository.createPostTradeAnalysis
 * itself is not called anywhere else in this codebase yet (see its doc
 * comment) — a row here means a caller (a future analysis mechanism, or a
 * test) genuinely produced one.
 */
const confidenceString = z
  .string()
  .trim()
  .regex(/^(0(\.\d+)?|1(\.0+)?)$/, "confidence must be a decimal string between 0 and 1");

export const createPostTradeAnalysisSchema = z.object({
  tradeId: z.string().uuid(),
  tradeSource: z.enum(TRADE_SOURCES),
  outcome: z.enum(POST_TRADE_OUTCOMES),
  primaryCause: z.enum(LOSS_CATEGORIES).optional(),
  contributingFactors: z.array(z.enum(LOSS_CATEGORIES)).default([]),
  confidence: confidenceString.optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
  researchHypotheses: z.array(z.string().trim().min(1)).default([]),
});
export type CreatePostTradeAnalysisInput = z.infer<typeof createPostTradeAnalysisSchema>;

export const postTradeAnalysisListQuerySchema = z.object({
  tradeId: z.string().uuid().optional(),
  tradeSource: z.enum(TRADE_SOURCES).optional(),
});
export type PostTradeAnalysisListQuery = z.infer<typeof postTradeAnalysisListQuerySchema>;
