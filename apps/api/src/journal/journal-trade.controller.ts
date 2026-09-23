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
import { ScreenshotService } from "../screenshots/screenshot.service";
import { JournalTradeService } from "./journal-trade.service";

@Controller("journal/trades")
export class JournalTradeController {
  constructor(
    private readonly journalTradeService: JournalTradeService,
    private readonly screenshotService: ScreenshotService,
  ) {}

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

  @Get(":id/screenshots")
  listScreenshots(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.screenshotService.listForTrade(id);
  }

  /**
   * Manual/admin trigger - idempotent, returns the existing row if a
   * POST_TRADE screenshot has already been requested or generated for this
   * trade. The automatic trigger on close (see
   * journal-trade.service.ts#close) is what fires this in the normal flow.
   */
  @Post(":id/screenshots/post-trade")
  @HttpCode(HttpStatus.ACCEPTED)
  requestPostTradeScreenshot(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.screenshotService.requestPostTradeScreenshot(id);
  }
}
