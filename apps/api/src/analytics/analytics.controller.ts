import { Controller, Get, Param, ParseUUIDPipe, Query, UsePipes } from "@nestjs/common";
import { analyticsQuerySchema, type AnalyticsQuery } from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { analyticsComparisonQuerySchema, type AnalyticsComparisonQuery } from "./analytics.schemas";
import { AnalyticsService } from "./analytics.service";

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get("strategies")
  strategies() {
    return this.analyticsService.strategiesOverview();
  }

  @Get("strategies/:strategyId")
  strategy(@Param("strategyId", new ParseUUIDPipe()) strategyId: string) {
    return this.analyticsService.strategyOverview(strategyId);
  }

  @Get("strategies/:strategyId/versions/:versionId")
  strategyVersion(
    @Param("strategyId", new ParseUUIDPipe()) strategyId: string,
    @Param("versionId", new ParseUUIDPipe()) versionId: string,
  ) {
    return this.analyticsService.strategyVersionDetail(strategyId, versionId);
  }

  @Get("comparison")
  @UsePipes(new ZodValidationPipe(analyticsComparisonQuerySchema))
  comparison(@Query() query: AnalyticsComparisonQuery) {
    return this.analyticsService.comparison(query);
  }

  @Get("winners-losers")
  @UsePipes(new ZodValidationPipe(analyticsQuerySchema))
  winnersLosers(@Query() query: AnalyticsQuery) {
    return this.analyticsService.winnersLosers(query);
  }
}
