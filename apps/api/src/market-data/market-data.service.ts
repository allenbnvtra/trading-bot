import type { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import { importCandlesFromStream, prisma, type CandleImportSummary } from "@trading-copilot/database";
import type { Timeframe } from "@trading-copilot/shared-types";

export interface ImportCandlesParams {
  instrumentId: string;
  timeframe: Timeframe;
}

@Injectable()
export class MarketDataService {
  /**
   * All CSV parsing/validation/upsert logic lives in
   * @trading-copilot/database's importCandlesFromStream — this service is a
   * thin pass-through, never re-implementing that validation here.
   */
  importCandles(stream: Readable, params: ImportCandlesParams): Promise<CandleImportSummary> {
    return importCandlesFromStream(prisma, stream, params);
  }
}
