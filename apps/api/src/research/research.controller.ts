import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  createResearchExperimentRequestSchema,
  generateResearchHypothesisRequestSchema,
  markPaperCandidateRequestSchema,
  type CreateResearchExperimentRequestInput,
  type GenerateResearchHypothesisRequestInput,
} from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ResearchService } from "./research.service";

/**
 * Thin: every handler validates its body via a shared-types Zod schema
 * through ZodValidationPipe (so an invalid body is a 400 with the Zod
 * issues, matching every other controller in apps/api, rather than a raw
 * ZodError escaping as a 500) and delegates straight to ResearchService. No
 * backtesting, research-analytics, or strategy-lifecycle logic here.
 */
@Controller("research")
export class ResearchController {
  constructor(private readonly researchService: ResearchService) {}

  @Post("hypotheses/generate")
  generate(@Body(new ZodValidationPipe(generateResearchHypothesisRequestSchema)) input: GenerateResearchHypothesisRequestInput) {
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
  createExperiment(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createResearchExperimentRequestSchema)) input: CreateResearchExperimentRequestInput,
  ) {
    return this.researchService.createExperiment(id, input);
  }

  /**
   * Human-gated: markPaperCandidateRequestSchema requires
   * `confirmedByHuman: true` in the body, so this route can never silently
   * promote a StrategyVersion from an automated caller that just sends an
   * empty/wrong payload.
   */
  @Post("hypotheses/:id/strategy-versions/:versionId/mark-paper-candidate")
  async markPaperCandidate(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Body(new ZodValidationPipe(markPaperCandidateRequestSchema)) _body: unknown,
  ) {
    await this.researchService.markPaperCandidate(id, versionId);
    return { status: "PAPER_CANDIDATE" };
  }
}
