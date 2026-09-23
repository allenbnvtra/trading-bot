import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { RESEARCH_AGENT_QUEUE } from "@trading-copilot/shared-types";
import { ResearchController } from "./research.controller";
import { ResearchService } from "./research.service";

@Module({
  imports: [BullModule.registerQueue({ name: RESEARCH_AGENT_QUEUE })],
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
