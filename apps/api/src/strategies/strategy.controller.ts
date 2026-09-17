import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import type { Strategy } from "@trading-copilot/trading-domain";
import { StrategyService } from "./strategy.service";

@Controller("strategies")
export class StrategyController {
  constructor(private readonly strategyService: StrategyService) {}

  @Get()
  list(): Promise<Strategy[]> {
    return this.strategyService.list();
  }

  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.strategyService.getById(id);
  }
}
