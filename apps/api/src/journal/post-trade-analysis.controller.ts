import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UsePipes } from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  createPostTradeAnalysisSchema,
  postTradeAnalysisListQuerySchema,
  type CreatePostTradeAnalysisInput,
  type PostTradeAnalysisListQuery,
} from "./post-trade-analysis.schemas";
import { PostTradeAnalysisService } from "./post-trade-analysis.service";

@Controller("post-trade-analyses")
export class PostTradeAnalysisController {
  constructor(private readonly postTradeAnalysisService: PostTradeAnalysisService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createPostTradeAnalysisSchema))
  create(@Body() body: CreatePostTradeAnalysisInput) {
    return this.postTradeAnalysisService.create(body);
  }

  @Get()
  @UsePipes(new ZodValidationPipe(postTradeAnalysisListQuerySchema))
  list(@Query() query: PostTradeAnalysisListQuery) {
    return this.postTradeAnalysisService.list(query);
  }

  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.postTradeAnalysisService.getById(id);
  }
}
