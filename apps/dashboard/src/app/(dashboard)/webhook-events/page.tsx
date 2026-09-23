import Link from "next/link";
import { ApiError, getWebhookEvents, type InboundWebhookEvent, type WebhookProcessingStatus } from "@/lib/api";
import { formatDateTime, formatDurationBetween } from "@/lib/format";
import { WebhookProcessingStatusBadge } from "@/components/StatusBadge";
import FilterForm, { type FilterField } from "@/components/FilterForm";

const PROCESSING_STATUSES: WebhookProcessingStatus[] = [
  "RECEIVED",
  "QUEUED",
  "PROCESSING",
  "PROCESSED",
  "DUPLICATE",
  "REJECTED",
  "FAILED",
  "UNSUPPORTED",
];

interface WebhookEventsSearchParams {
  processingStatus?: string;
  setupId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export default async function WebhookEventsPage({
  searchParams,
}: {
  searchParams: Promise<WebhookEventsSearchParams>;
}) {
  const params = await searchParams;

  let events: InboundWebhookEvent[] = [];
  let loadError: string | null = null;

  try {
    events = await getWebhookEvents({
      processingStatus: params.processingStatus as WebhookProcessingStatus | undefined,
      setupId: params.setupId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load webhook events.";
  }

  const fields: FilterField[] = [
    {
      type: "select",
      name: "processingStatus",
      label: "Processing Status",
      options: PROCESSING_STATUSES.map((status) => ({ value: status, label: status })),
    },
    { type: "date", name: "dateFrom", label: "Date From" },
    { type: "date", name: "dateTo", label: "Date To" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Webhook Events</h1>
        <p>
          Every inbound TradingView webhook delivery, durable and admin-inspectable -
          including ones that were rejected before a Setup was ever created. See{" "}
          <Link href="/live-setups">Live Setups</Link> for the resulting Setups themselves.
        </p>
      </div>

      <div className="card">
        <FilterForm fields={fields} values={params} />
        {params.setupId && (
          <p className="muted">
            Filtered to setupId {params.setupId}.{" "}
            <a href="?">Clear</a>
          </p>
        )}

        {loadError && <div className="error-banner">{loadError}</div>}

        {!loadError && events.length === 0 && (
          <div className="empty-state">No webhook events match these filters.</div>
        )}

        {!loadError && events.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Provider</th>
                  <th>Schema Version</th>
                  <th>Status</th>
                  <th>Failure</th>
                  <th>Setup</th>
                  <th>Processing Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <Link href={`/webhook-events/${event.id}`}>{formatDateTime(event.receivedAt)}</Link>
                    </td>
                    <td>{event.provider}</td>
                    <td>{event.schemaVersion}</td>
                    <td>
                      <WebhookProcessingStatusBadge status={event.processingStatus} />
                    </td>
                    <td>
                      {event.failureCode ? (
                        <span title={event.failureMessage ?? undefined}>{event.failureCode}</span>
                      ) : (
                        "N/A"
                      )}
                    </td>
                    <td>
                      {event.setupId ? (
                        <Link href={`/setups/${event.setupId}`}>{event.setupId}</Link>
                      ) : (
                        "N/A"
                      )}
                    </td>
                    <td>{formatDurationBetween(event.processingStartedAt, event.processingCompletedAt)}</td>
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
