import { Module } from "@nestjs/common";
import { JournalEventController } from "./journal-event.controller";
import { JournalEventService } from "./journal-event.service";
import { JournalTradeController } from "./journal-trade.controller";
import { JournalTradeService } from "./journal-trade.service";
import { PostTradeAnalysisController } from "./post-trade-analysis.controller";
import { PostTradeAnalysisService } from "./post-trade-analysis.service";

@Module({
  controllers: [JournalTradeController, JournalEventController, PostTradeAnalysisController],
  providers: [JournalTradeService, JournalEventService, PostTradeAnalysisService],
})
export class JournalModule {}
