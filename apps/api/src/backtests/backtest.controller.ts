import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UsePipes } from "@nestjs/common";
import { createBacktestRequestSchema, type CreateBacktestRequestInput } from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { BacktestService } from "./backtest.service";

@Controller("backtests")
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createBacktestRequestSchema))
  create(@Body() body: CreateBacktestRequestInput) {
    return this.backtestService.create(body);
  }

  @Get()
  list() {
    return this.backtestService.list();
  }

  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.backtestService.getById(id);
  }

  @Get(":id/trades")
  listTrades(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.backtestService.listTrades(id);
  }

  @Get(":id/trades/:tradeId")
  getTrade(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("tradeId", new ParseUUIDPipe()) tradeId: string,
  ) {
    return this.backtestService.getTrade(id, tradeId);
  }
}
