import { Controller, Get, Query, UsePipes } from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { journalEventListQuerySchema, type JournalEventListQuery } from "./journal-event.schemas";
import { JournalEventService } from "./journal-event.service";

/**
 * Read-only surface for the append-only journal event log — the dashboard's
 * `/journal` timeline page. There is deliberately no POST endpoint here:
 * events are only ever emitted as a side effect of setup/risk-calculation/
 * journal-trade/post-trade-analysis repository calls.
 */
@Controller("journal/events")
export class JournalEventController {
  constructor(private readonly journalEventService: JournalEventService) {}

  @Get()
  @UsePipes(new ZodValidationPipe(journalEventListQuerySchema))
  list(@Query() query: JournalEventListQuery) {
    return this.journalEventService.list(query);
  }
}
