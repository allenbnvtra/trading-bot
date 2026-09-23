import { Readable } from "node:stream";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UsePipes,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { z } from "zod";
import { PRE_TRADE_CANDLE_COUNT_DEFAULT, TIMEFRAMES } from "@trading-copilot/shared-types";
import type { CandleImportSummary } from "@trading-copilot/database";
import type { Candle } from "@trading-copilot/trading-domain";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { MarketDataService } from "./market-data.service";

/**
 * Small inline schema for the multipart form fields (the file itself is
 * handled separately by Multer/FileInterceptor, not by Zod).
 */
const importMarketDataFieldsSchema = z.object({
  instrumentId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
});

/**
 * `count`'s `max(1000)` is a defensive request-size cap on this
 * admin/internal endpoint (never asked to return an unbounded result set) —
 * not itself financial logic, per CLAUDE.md's "validate all external input."
 * `cutoffTimestamp` must be a strict ISO-8601 datetime string; the render
 * route (apps/dashboard's internal render pages) is the only caller and
 * always passes `MarketSnapshot.timestamp`/`JournalTrade.exitTimestamp`
 * verbatim — this endpoint itself has no way to enforce which timestamp its
 * caller chooses, so that guarantee lives at the call site, not here.
 */
const getCandlesQuerySchema = z.object({
  instrumentId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
  cutoffTimestamp: z.string().datetime(),
  count: z.coerce.number().int().positive().max(1000).default(PRE_TRADE_CANDLE_COUNT_DEFAULT),
});

@Controller("market-data")
export class MarketDataController {
  constructor(private readonly marketDataService: MarketDataService) {}

  @Post("import")
  @UseInterceptors(
    // Memory storage buffers the whole upload for Milestone 1's
    // fixture-sized CSV files. True disk-based streaming for very large
    // uploads is a future improvement, not a Milestone 1 requirement.
    FileInterceptor("file", { storage: memoryStorage() }),
  )
  async import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, string>,
  ): Promise<CandleImportSummary> {
    if (!file) {
      throw new BadRequestException('A CSV file must be uploaded under the "file" field');
    }

    const parsed = importMarketDataFieldsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Validation failed",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const stream = Readable.from(file.buffer);
    // Return the summary as-is (including rejected/errors) — never swallow
    // partial import failures.
    return this.marketDataService.importCandles(stream, parsed.data);
  }

  @Get("candles")
  @UsePipes(new ZodValidationPipe(getCandlesQuerySchema))
  getCandles(@Query() query: z.infer<typeof getCandlesQuerySchema>): Promise<Candle[]> {
    return this.marketDataService.getCandlesUpToTimestamp(
      query.instrumentId,
      query.timeframe,
      new Date(query.cutoffTimestamp),
      query.count,
    );
  }
}
