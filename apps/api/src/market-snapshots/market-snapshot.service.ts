import { Injectable, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { marketSnapshotsRepository } from "@trading-copilot/database";
import type { CreateMarketSnapshotInput } from "@trading-copilot/shared-types";
import type { MarketSnapshot } from "@trading-copilot/trading-domain";
import type { MarketSnapshotListQuery } from "./market-snapshot.schemas";

function toDecimal(value: string | undefined): Decimal | null {
  return value === undefined ? null : new Decimal(value);
}

function toDate(value: string | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

/**
 * Converts validated request strings (ISO timestamps, decimal strings) to
 * Date/Decimal here, at the service layer — never in the controller, and
 * never passed as raw strings into the repository, which only accepts
 * Date/Decimal (see packages/database/src/repositories/market-snapshots.ts).
 */
@Injectable()
export class MarketSnapshotService {
  create(input: CreateMarketSnapshotInput): Promise<MarketSnapshot> {
    return marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: input.instrumentId,
      timestamp: new Date(input.timestamp),
      timeframe: input.timeframe,
      windowCandleCount: input.windowCandleCount ?? null,
      windowStartTimestamp: toDate(input.windowStartTimestamp),
      windowEndTimestamp: toDate(input.windowEndTimestamp),
      trend1m: input.trend1m ?? null,
      trend5m: input.trend5m ?? null,
      trend15m: input.trend15m ?? null,
      trend1h: input.trend1h ?? null,
      trend4h: input.trend4h ?? null,
      trend1d: input.trend1d ?? null,
      atr: toDecimal(input.atr),
      atrPercentile: toDecimal(input.atrPercentile),
      volume: toDecimal(input.volume),
      volumePercentile: toDecimal(input.volumePercentile),
      vwap: toDecimal(input.vwap),
      vwapDistance: toDecimal(input.vwapDistance),
      nearestSupport: toDecimal(input.nearestSupport),
      distanceToSupport: toDecimal(input.distanceToSupport),
      nearestResistance: toDecimal(input.nearestResistance),
      distanceToResistance: toDecimal(input.distanceToResistance),
      session: input.session ?? null,
      timeOfDay: input.timeOfDay ?? null,
      dayOfWeek: input.dayOfWeek ?? null,
      marketRegime: input.marketRegime ?? null,
      metadata: input.metadata,
    });
  }

  list(query: MarketSnapshotListQuery): Promise<MarketSnapshot[]> {
    return marketSnapshotsRepository.listMarketSnapshots({
      instrumentId: query.instrumentId,
      timeframe: query.timeframe,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });
  }

  async getById(id: string): Promise<MarketSnapshot> {
    const snapshot = await marketSnapshotsRepository.getMarketSnapshot(id);
    if (!snapshot) {
      throw new NotFoundException(`MarketSnapshot ${id} not found`);
    }
    return snapshot;
  }
}
