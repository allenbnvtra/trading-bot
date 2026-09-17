import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ApiError,
  getWebhookEvent,
  getWebhookEventTimeline,
  type JournalEvent,
} from "@/lib/api";
import { formatDateTime, formatDurationBetween } from "@/lib/format";
import { WebhookProcessingStatusBadge } from "@/components/StatusBadge";
import EventTimeline from "@/components/EventTimeline";

export default async function WebhookEventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let event;
  try {
    event = await getWebhookEvent(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load webhook event.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Webhook Event</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  let timeline: JournalEvent[] = [];
  let timelineError: string | null = null;
  try {
    timeline = await getWebhookEventTimeline(id);
  } catch (err) {
    timelineError = err instanceof ApiError ? err.message : "Failed to load webhook event timeline.";
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Webhook Event</h1>
        <p className="muted">
          <Link href="/webhook-events">&larr; back to webhook events</Link>
        </p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Received</div>
            <div className="detail-item__value">{formatDateTime(event.receivedAt)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Provider</div>
            <div className="detail-item__value">{event.provider}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Schema Version</div>
            <div className="detail-item__value">{event.schemaVersion}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Processing Status</div>
            <div className="detail-item__value">
              <WebhookProcessingStatusBadge status={event.processingStatus} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Processing Started</div>
            <div className="detail-item__value">{formatDateTime(event.processingStartedAt)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Processing Completed</div>
            <div className="detail-item__value">{formatDateTime(event.processingCompletedAt)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Processing Time</div>
            <div className="detail-item__value">
              {formatDurationBetween(event.processingStartedAt, event.processingCompletedAt)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Fingerprint</div>
            <div className="detail-item__value">{event.fingerprint}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Setup</div>
            <div className="detail-item__value">
              {event.setupId ? (
                <Link href={`/setups/${event.setupId}`}>{event.setupId}</Link>
              ) : (
                "No setup was created for this delivery"
              )}
            </div>
          </div>
        </div>

        {(event.failureCode || event.failureMessage) && (
          <div className="detail-grid detail-grid--spaced">
            <div className="detail-item">
              <div className="detail-item__label">Failure Code</div>
              <div className="detail-item__value">{event.failureCode ?? "Not set"}</div>
            </div>
            <div className="detail-item detail-item--full">
              <div className="detail-item__label">Failure Message</div>
              <div className="detail-item__value">{event.failureMessage ?? "Not set"}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Raw Payload</h2>
        <pre className="params">{JSON.stringify(event.rawPayload, null, 2)}</pre>
      </div>

      <div className="card">
        <h2>Normalized Payload</h2>
        {event.normalizedPayload ? (
          <pre className="params">{JSON.stringify(event.normalizedPayload, null, 2)}</pre>
        ) : (
          <div className="empty-state">
            Not yet normalized (or normalization never succeeded for this delivery).
          </div>
        )}
      </div>

      <div className="card">
        <h2>Timeline</h2>
        {timelineError && <div className="error-banner">{timelineError}</div>}
        {!timelineError && <EventTimeline events={timeline} />}
      </div>
    </div>
  );
}
