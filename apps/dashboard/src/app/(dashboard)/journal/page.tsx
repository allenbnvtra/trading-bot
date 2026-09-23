import Link from "next/link";
import {
  ApiError,
  getInstruments,
  getJournalEvents,
  getStrategies,
  type JournalEntityType,
  type JournalEvent,
  type JournalEventType,
} from "@/lib/api";
import { getAllStrategyVersions } from "@/lib/strategy-versions";
import { formatDateTime } from "@/lib/format";
import { EVENT_TYPE_LABELS, EventTypeBadge } from "@/components/StatusBadge";
import FilterForm, { type FilterField } from "@/components/FilterForm";

const ENTITY_TYPES: JournalEntityType[] = [
  "SETUP",
  "JOURNAL_TRADE",
  "RISK_CALCULATION",
  "MARKET_SNAPSHOT",
  "BACKTEST",
  "BACKTEST_TRADE",
  "STRATEGY_VERSION",
  "POST_TRADE_ANALYSIS",
  "INBOUND_WEBHOOK_EVENT",
];

const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS) as JournalEventType[];

interface JournalSearchParams {
  entityType?: string;
  eventType?: string;
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<JournalSearchParams>;
}) {
  const params = await searchParams;

  let events: JournalEvent[] = [];
  let loadError: string | null = null;
  let instrumentOptions: { value: string; label: string }[] = [];
  let strategyOptions: { value: string; label: string }[] = [];
  let strategyVersionOptions: { value: string; label: string }[] = [];

  try {
    const [instruments, strategies, strategyVersions, fetchedEvents] = await Promise.all([
      getInstruments(),
      getStrategies(),
      getAllStrategyVersions(),
      getJournalEvents({
        entityType: params.entityType as JournalEntityType | undefined,
        instrumentId: params.instrumentId,
        strategyId: params.strategyId,
        strategyVersionId: params.strategyVersionId,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      }),
    ]);

    instrumentOptions = instruments.map((instrument) => ({
      value: instrument.id,
      label: instrument.symbol,
    }));
    strategyOptions = strategies.map((strategy) => ({ value: strategy.id, label: strategy.name }));
    strategyVersionOptions = strategyVersions.map((version) => ({
      value: version.id,
      label: `${version.strategyName} - ${version.version}`,
    }));

    // There is no `eventType` filter on the API (it filters by `entityType`
    // only), so this narrows the already-fetched, already-filtered list.
    events = params.eventType
      ? fetchedEvents.filter((event) => event.eventType === params.eventType)
      : fetchedEvents;
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load journal events.";
  }

  const fields: FilterField[] = [
    {
      type: "select",
      name: "entityType",
      label: "Entity Type",
      options: ENTITY_TYPES.map((type) => ({ value: type, label: type })),
    },
    {
      type: "select",
      name: "eventType",
      label: "Event Type",
      options: EVENT_TYPES.map((type) => ({ value: type, label: EVENT_TYPE_LABELS[type] })),
    },
    { type: "select", name: "instrumentId", label: "Instrument", options: instrumentOptions },
    { type: "select", name: "strategyId", label: "Strategy", options: strategyOptions },
    {
      type: "select",
      name: "strategyVersionId",
      label: "Strategy Version",
      options: strategyVersionOptions,
    },
    { type: "date", name: "dateFrom", label: "Date From" },
    { type: "date", name: "dateTo", label: "Date To" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Journal</h1>
        <p>
          Chronological, append-only log of every setup, risk calculation, and trade lifecycle
          event.
        </p>
      </div>

      <div className="card">
        <FilterForm fields={fields} values={params} />

        {loadError && <div className="error-banner">{loadError}</div>}

        {!loadError && events.length === 0 && (
          <div className="empty-state">No journal events match these filters.</div>
        )}

        {!loadError && events.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Event Type</th>
                  <th>Entity Type</th>
                  <th>Entity Id</th>
                  <th>Correlation Id</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.timestamp)}</td>
                    <td>
                      <EventTypeBadge eventType={event.eventType} />
                    </td>
                    <td>{event.entityType}</td>
                    <td>
                      {event.entityType === "JOURNAL_TRADE" && (
                        <Link href={`/trades/${event.entityId}`}>{event.entityId}</Link>
                      )}
                      {event.entityType === "SETUP" && (
                        <Link href={`/setups/${event.entityId}`}>{event.entityId}</Link>
                      )}
                      {event.entityType === "INBOUND_WEBHOOK_EVENT" && (
                        <Link href={`/webhook-events/${event.entityId}`}>{event.entityId}</Link>
                      )}
                      {event.entityType !== "JOURNAL_TRADE" &&
                        event.entityType !== "SETUP" &&
                        event.entityType !== "INBOUND_WEBHOOK_EVENT" &&
                        event.entityId}
                    </td>
                    <td>{event.correlationId ?? "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
