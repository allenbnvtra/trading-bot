import type { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import type { LossCategory, PostTradeOutcome, TradeSource } from "@trading-copilot/shared-types";
import type { PostTradeAnalysis } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapPostTradeAnalysis } from "../mappers";
import { createJournalEvent } from "./journal-events";

/**
 * Nothing else in this codebase calls this module — see CLAUDE.md and
 * docs/research-methodology.md. A row here means a genuine analysis
 * mechanism (not built yet) produced it, or a test exercised it directly.
 */

export interface CreatePostTradeAnalysisInput {
  tradeId: string;
  tradeSource: TradeSource;
  outcome: PostTradeOutcome;
  primaryCause?: LossCategory | null;
  contributingFactors?: LossCategory[];
  confidence?: Decimal | null;
  evidence?: Record<string, unknown>;
  researchHypotheses?: string[];
}

export async function createPostTradeAnalysis(
  input: CreatePostTradeAnalysisInput,
): Promise<PostTradeAnalysis> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.postTradeAnalysis.create({
      data: {
        tradeId: input.tradeId,
        tradeSource: input.tradeSource,
        outcome: input.outcome,
        primaryCause: input.primaryCause ?? null,
        contributingFactors: input.contributingFactors ?? [],
        confidence: input.confidence?.toString() ?? null,
        evidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
        researchHypotheses: input.researchHypotheses ?? [],
      },
    });

    // A JournalTrade's events all correlate on its Setup's id (see
    // journal-trades.ts / journal-events.ts), so a post-trade analysis of a
    // JournalTrade joins that same timeline. A BacktestTrade has no Setup
    // (Milestone 1 predates the journal), so its own id is the correlation
    // anchor instead.
    let correlationId = input.tradeId;
    let instrumentId: string | null = null;
    let strategyId: string | null = null;
    let strategyVersionId: string | null = null;

    if (input.tradeSource === "JOURNAL_TRADE") {
      const trade = await tx.journalTrade.findUnique({ where: { id: input.tradeId } });
      if (trade) {
        correlationId = trade.setupId ?? input.tradeId;
        instrumentId = trade.instrumentId;
        strategyId = trade.strategyId;
        strategyVersionId = trade.strategyVersionId;
      }
    } else {
      const trade = await tx.backtestTrade.findUnique({ where: { id: input.tradeId } });
      if (trade) {
        instrumentId = trade.instrumentId;
        strategyVersionId = trade.strategyVersionId;
        const strategyVersion = await tx.strategyVersion.findUnique({
          where: { id: trade.strategyVersionId },
        });
        strategyId = strategyVersion?.strategyId ?? null;
      }
    }

    await createJournalEvent(
      {
        eventType: "POST_TRADE_ANALYSIS_CREATED",
        entityType: "POST_TRADE_ANALYSIS",
        entityId: row.id,
        correlationId,
        instrumentId,
        strategyId,
        strategyVersionId,
      },
      tx,
    );

    return mapPostTradeAnalysis(row);
  });
}

export async function getPostTradeAnalysis(id: string): Promise<PostTradeAnalysis | null> {
  const row = await prisma.postTradeAnalysis.findUnique({ where: { id } });
  return row ? mapPostTradeAnalysis(row) : null;
}

export interface PostTradeAnalysisFilters {
  tradeId?: string;
  tradeSource?: TradeSource;
}

export async function listPostTradeAnalyses(
  filters: PostTradeAnalysisFilters = {},
): Promise<PostTradeAnalysis[]> {
  const rows = await prisma.postTradeAnalysis.findMany({
    where: { tradeId: filters.tradeId, tradeSource: filters.tradeSource },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapPostTradeAnalysis);
}
