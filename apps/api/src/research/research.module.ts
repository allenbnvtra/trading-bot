import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { RESEARCH_AGENT_JOB_OPTIONS, RESEARCH_AGENT_QUEUE } from "@trading-copilot/shared-types";
import { BACKTEST_RUN_QUEUE } from "../common/queue.constants";
import { ResearchController } from "./research.controller";
import { ResearchService } from "./research.service";

@Module({
  imports: [
    // defaultJobOptions only apply to jobs added through the Queue instance
    // they are registered on, and ResearchService.generateHypothesis adds
    // the research-agent job through THIS module's Queue, so the
    // attempts: 1 policy (an LLM call is neither free nor safe to retry
    // automatically, see RESEARCH_AGENT_JOB_OPTIONS) must be registered
    // here, not only on the worker side.
    BullModule.registerQueue({ name: RESEARCH_AGENT_QUEUE, defaultJobOptions: RESEARCH_AGENT_JOB_OPTIONS }),
    // Every experiment's Backtest runs through the existing backtest-run
    // queue/BacktestRunProcessor, same as POST /backtests.
    BullModule.registerQueue({ name: BACKTEST_RUN_QUEUE }),
  ],
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
