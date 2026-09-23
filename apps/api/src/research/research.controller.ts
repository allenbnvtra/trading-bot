import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  createResearchExperimentRequestSchema,
  generateResearchHypothesisRequestSchema,
  markPaperCandidateRequestSchema,
} from "@trading-copilot/shared-types";
import { ResearchService } from "./research.service";

/**
 * Thin: every handler validates via a shared-types Zod schema
 * (`.parse(body)` on an `unknown` body, never trusting the body's inferred
 * type directly) and delegates straight to ResearchService. No backtesting,
 * research-analytics, or strategy-lifecycle logic here.
 */
@Controller("research")
export class ResearchController {
  constructor(private readonly researchService: ResearchService) {}

  @Post("hypotheses/generate")
  generate(@Body() body: unknown) {
    const input = generateResearchHypothesisRequestSchema.parse(body);
    return this.researchService.generateHypothesis(input);
  }

  @Get("hypotheses")
  list() {
    return this.researchService.listHypotheses();
  }

  @Get("hypotheses/:id")
  getById(@Param("id") id: string) {
    return this.researchService.getHypothesis(id);
  }

  @Post("hypotheses/:id/experiments")
  createExperiment(@Param("id") id: string, @Body() body: unknown) {
    const input = createResearchExperimentRequestSchema.parse(body);
    return this.researchService.createExperiment(id, input);
  }

  /**
   * Human-gated: markPaperCandidateRequestSchema requires
   * `confirmedByHuman: true` in the body, so this route can never silently
   * promote a StrategyVersion from an automated caller that just sends an
   * empty/wrong payload.
   */
  @Post("hypotheses/:id/strategy-versions/:versionId/mark-paper-candidate")
  async markPaperCandidate(@Param("id") id: string, @Param("versionId") versionId: string, @Body() body: unknown) {
    markPaperCandidateRequestSchema.parse(body);
    await this.researchService.markPaperCandidate(id, versionId);
    return { status: "PAPER_CANDIDATE" };
  }
}
