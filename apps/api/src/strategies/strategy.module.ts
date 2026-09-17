import { Module } from "@nestjs/common";
import { StrategyController } from "./strategy.controller";
import { StrategyService } from "./strategy.service";

@Module({
  controllers: [StrategyController],
  providers: [StrategyService],
})
export class StrategyModule {}
