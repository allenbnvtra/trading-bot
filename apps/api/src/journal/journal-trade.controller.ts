import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UsePipes } from "@nestjs/common";
import {
  closeJournalTradeSchema,
  createJournalTradeSchema,
  journalTradeListQuerySchema,
  recordJournalTradeEntrySchema,
  type CloseJournalTradeInput,
  type CreateJournalTradeInput,
  type JournalTradeListQuery,
  type RecordJournalTradeEntryInput,
} from "@trading-copilot/shared-types";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { JournalTradeService } from "./journal-trade.service";

@Controller("journal/trades")
export class JournalTradeController {
  constructor(private readonly journalTradeService: JournalTradeService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createJournalTradeSchema))
  create(@Body() body: CreateJournalTradeInput) {
    return this.journalTradeService.create(body);
  }

  @Get()
  @UsePipes(new ZodValidationPipe(journalTradeListQuerySchema))
  list(@Query() query: JournalTradeListQuery) {
    return this.journalTradeService.list(query);
  }

  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.journalTradeService.getById(id);
  }

  @Post(":id/entry")
  recordEntry(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(recordJournalTradeEntrySchema)) body: RecordJournalTradeEntryInput,
  ) {
    return this.journalTradeService.recordEntry(id, body);
  }

  @Post(":id/close")
  close(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(closeJournalTradeSchema)) body: CloseJournalTradeInput,
  ) {
    return this.journalTradeService.close(id, body);
  }
}
