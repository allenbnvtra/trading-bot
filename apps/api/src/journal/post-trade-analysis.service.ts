import { Injectable, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { postTradeAnalysesRepository } from "@trading-copilot/database";
import type { PostTradeAnalysis } from "@trading-copilot/trading-domain";
import type { CreatePostTradeAnalysisInput, PostTradeAnalysisListQuery } from "./post-trade-analysis.schemas";

@Injectable()
export class PostTradeAnalysisService {
  create(input: CreatePostTradeAnalysisInput): Promise<PostTradeAnalysis> {
    return postTradeAnalysesRepository.createPostTradeAnalysis({
      tradeId: input.tradeId,
      tradeSource: input.tradeSource,
      outcome: input.outcome,
      primaryCause: input.primaryCause ?? null,
      contributingFactors: input.contributingFactors,
      confidence: input.confidence ? new Decimal(input.confidence) : null,
      evidence: input.evidence,
      researchHypotheses: input.researchHypotheses,
    });
  }

  list(query: PostTradeAnalysisListQuery): Promise<PostTradeAnalysis[]> {
    return postTradeAnalysesRepository.listPostTradeAnalyses(query);
  }

  async getById(id: string): Promise<PostTradeAnalysis> {
    const analysis = await postTradeAnalysesRepository.getPostTradeAnalysis(id);
    if (!analysis) {
      throw new NotFoundException(`PostTradeAnalysis ${id} not found`);
    }
    return analysis;
  }
}
