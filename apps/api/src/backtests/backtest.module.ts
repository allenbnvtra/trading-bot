import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { BACKTEST_RUN_QUEUE } from "../common/queue.constants";
import { BacktestController } from "./backtest.controller";
import { BacktestService } from "./backtest.service";

@Module({
  imports: [BullModule.registerQueue({ name: BACKTEST_RUN_QUEUE })],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
