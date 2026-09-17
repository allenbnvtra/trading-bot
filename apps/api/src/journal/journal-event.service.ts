import { Injectable } from "@nestjs/common";
import { journalEventsRepository } from "@trading-copilot/database";
import type { JournalEvent } from "@trading-copilot/trading-domain";
import type { JournalEventListQuery } from "./journal-event.schemas";

@Injectable()
export class JournalEventService {
  list(query: JournalEventListQuery): Promise<JournalEvent[]> {
    return journalEventsRepository.listJournalEvents({
      entityType: query.entityType,
      entityId: query.entityId,
      correlationId: query.correlationId,
      instrumentId: query.instrumentId,
      strategyId: query.strategyId,
      strategyVersionId: query.strategyVersionId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });
  }
}
