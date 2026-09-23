import type { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import {
  candlesRepository,
  importCandlesFromStream,
  prisma,
  type CandleImportSummary,
} from "@trading-copilot/database";
import type { Timeframe } from "@trading-copilot/shared-types";
import type { Candle } from "@trading-copilot/trading-domain";

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

  /**
   * Thin pass-through to the anti-look-ahead-safe candle query
   * (candlesRepository.getCandlesUpToTimestamp, Task 2). The
   * `timestamp <= cutoffTimestamp` filter is enforced by that query's own
   * SQL WHERE clause — this service never fetches a wider range and trims
   * it down here, which would defeat the whole point.
   */
  getCandlesUpToTimestamp(
    instrumentId: string,
    timeframe: Timeframe,
    cutoffTimestamp: Date,
    count: number,
  ): Promise<Candle[]> {
    return candlesRepository.getCandlesUpToTimestamp(instrumentId, timeframe, cutoffTimestamp, count);
  }
}
