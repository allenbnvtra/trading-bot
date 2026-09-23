import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { RESEARCH_AGENT_QUEUE } from "@trading-copilot/shared-types";
import { BACKTEST_RUN_QUEUE } from "../common/queue.constants";
import { ResearchController } from "./research.controller";
import { ResearchService } from "./research.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: RESEARCH_AGENT_QUEUE }),
    // Every experiment's Backtest runs through the existing backtest-run
    // queue/BacktestRunProcessor, same as POST /backtests.
    BullModule.registerQueue({ name: BACKTEST_RUN_QUEUE }),
  ],
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
