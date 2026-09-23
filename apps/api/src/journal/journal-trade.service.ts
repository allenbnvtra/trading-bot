import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { journalTradesRepository } from "@trading-copilot/database";
import type {
  CloseJournalTradeInput,
  CreateJournalTradeInput,
  JournalTradeListQuery,
  RecordJournalTradeEntryInput,
} from "@trading-copilot/shared-types";
import type { JournalTrade } from "@trading-copilot/trading-domain";
import { ScreenshotService } from "../screenshots/screenshot.service";

/**
 * JournalTradeStateError raised by recordJournalTradeEntry/closeJournalTrade
 * (wrong lifecycle state) and NotFoundError (missing trade) are left to
 * propagate to the global DomainErrorFilter — see setup.service.ts for the
 * same convention.
 */
@Injectable()
export class JournalTradeService {
  private readonly logger = new Logger(JournalTradeService.name);

  constructor(private readonly screenshotService: ScreenshotService) {}

  create(input: CreateJournalTradeInput): Promise<JournalTrade> {
    return journalTradesRepository.createJournalTrade({
      setupId: input.setupId ?? null,
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      direction: input.direction,
      plannedEntry: new Decimal(input.plannedEntry),
      plannedStop: new Decimal(input.plannedStop),
      plannedTarget1: input.plannedTarget1 ? new Decimal(input.plannedTarget1) : null,
      plannedTarget2: input.plannedTarget2 ? new Decimal(input.plannedTarget2) : null,
      plannedRisk: input.plannedRisk ? new Decimal(input.plannedRisk) : null,
      executionMode: input.executionMode,
      entryNotes: input.entryNotes ?? null,
    });
  }

  list(query: JournalTradeListQuery): Promise<JournalTrade[]> {
    return journalTradesRepository.listJournalTrades({
      instrumentId: query.instrumentId,
      strategyId: query.strategyId,
      strategyVersionId: query.strategyVersionId,
      direction: query.direction,
      executionMode: query.executionMode,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });
  }

  async getById(id: string): Promise<JournalTrade> {
    const trade = await journalTradesRepository.getJournalTrade(id);
    if (!trade) {
      throw new NotFoundException(`JournalTrade ${id} not found`);
    }
    return trade;
  }

  recordEntry(id: string, input: RecordJournalTradeEntryInput): Promise<JournalTrade> {
    return journalTradesRepository.recordJournalTradeEntry(id, {
      actualEntry: new Decimal(input.actualEntry),
      entryTimestamp: new Date(input.entryTimestamp),
      quantity: input.quantity,
      estimatedFees: input.estimatedFees ? new Decimal(input.estimatedFees) : null,
      estimatedSlippage: input.estimatedSlippage ? new Decimal(input.estimatedSlippage) : null,
    });
  }

  async close(id: string, input: CloseJournalTradeInput): Promise<JournalTrade> {
    const trade = await journalTradesRepository.closeJournalTrade(id, {
      actualExit: new Decimal(input.actualExit),
      exitTimestamp: new Date(input.exitTimestamp),
      actualFees: input.actualFees ? new Decimal(input.actualFees) : null,
      actualSlippage: input.actualSlippage ? new Decimal(input.actualSlippage) : null,
      mfe: input.mfe ? new Decimal(input.mfe) : null,
      mae: input.mae ? new Decimal(input.mae) : null,
      exitNotes: input.exitNotes ?? null,
    });

    // Screenshot generation is best-effort and must never fail the close
    // operation it is a side effect of — same convention as
    // setup.service.ts's READY-transition trigger. A trade with no Setup
    // lineage (setupId: null - a legitimate domain state, e.g. a
    // manually-logged trade) has no MarketSnapshot to source a timeframe
    // from, so there is no chart context to render at all: skip the
    // request entirely rather than create a row/job/Chromium launch that's
    // guaranteed to end FAILED every time. ScreenshotService itself also
    // rejects this case (422) for a caller hitting the manual endpoint
    // directly, but the automatic trigger here never even attempts it.
    if (trade.setupId === null) {
      this.logger.debug(
        `Skipping POST_TRADE screenshot for JournalTrade ${trade.id}: no Setup lineage (setupId is null), no chart context available.`,
      );
    } else {
      await this.screenshotService.requestPostTradeScreenshot(trade.id).catch((err: unknown) => {
        this.logger.warn(`Failed to request POST_TRADE screenshot for JournalTrade ${trade.id}: ${String(err)}`);
      });
    }

    return trade;
  }
}
