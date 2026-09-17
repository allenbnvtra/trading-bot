import { Readable } from "node:stream";
import { BadRequestException, Body, Controller, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { z } from "zod";
import { TIMEFRAMES } from "@trading-copilot/shared-types";
import type { CandleImportSummary } from "@trading-copilot/database";
import { MarketDataService } from "./market-data.service";

/**
 * Small inline schema for the multipart form fields (the file itself is
 * handled separately by Multer/FileInterceptor, not by Zod).
 */
const importMarketDataFieldsSchema = z.object({
  instrumentId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
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
}
