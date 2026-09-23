import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ApiError,
  getMarketSnapshot,
  getSetup,
  getSetupNotifications,
  getSetupScreenshots,
  getSetupTimeline,
  getWebhookEventTimeline,
  getWebhookEvents,
  type JournalEvent,
  type MarketSnapshot,
  type NotificationDelivery,
  type TradeScreenshot,
} from "@/lib/api";
import { formatDateTime, formatDecimal } from "@/lib/format";
import { DirectionBadge, SetupSourceBadge, SetupStatusBadge } from "@/components/StatusBadge";
import EventTimeline from "@/components/EventTimeline";
import { ScreenshotsSection } from "@/components/ScreenshotCard";
import NotificationsCard from "@/components/NotificationsCard";
import SetupActionsCard from "@/components/SetupActionsCard";

/** Renders a nullable planned price. Never "$0" or a blank cell - null means genuinely unknown, not zero. */
function plannedPriceValue(value: string | null): string {
  return value === null ? "Not set" : formatDecimal(value, 4);
}

export default async function SetupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let setup;
  try {
    setup = await getSetup(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load setup.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Setup</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  let snapshot: MarketSnapshot | null = null;
  try {
    snapshot = await getMarketSnapshot(setup.marketSnapshotId);
  } catch {
    // Rendered as "unknown" below - never fabricated.
  }

  // A Setup has no direct link back to the InboundWebhookEvent that created
  // it, so a TRADINGVIEW-sourced Setup's originating webhook event (if any)
  // is found by querying the admin/inspection endpoint by setupId. This is
  // best-effort: a failure here never blocks rendering the Setup itself.
  let webhookEventId: string | null = null;
  if (setup.source === "TRADINGVIEW") {
    try {
      const events = await getWebhookEvents({ setupId: id });
      webhookEventId = events[0]?.id ?? null;
    } catch {
      // Cross-link omitted, not fabricated.
    }
  }

  // Best-effort, same as webhookEventId above: a screenshots-fetch failure
  // never blocks rendering the Setup itself, it just leaves the section
  // showing an empty list.
  let screenshots: TradeScreenshot[] = [];
  try {
    screenshots = await getSetupScreenshots(id);
  } catch {
    // Rendered as "no screenshots" below - never fabricated.
  }

  // GET /setups/:id/timeline only returns JournalEvents correlated on the
  // Setup's own id. For a TRADINGVIEW-sourced Setup that misses the
  // WEBHOOK_RECEIVED/WEBHOOK_NORMALIZED events (correlated on the
  // InboundWebhookEvent's id, since they happen before the Setup exists) and
  // even SIGNAL_ACCEPTED (its correlationId is the webhook event's id even
  // though its entityId is this Setup - see docs/tradingview-setup.md
  // "Journal timeline"). Whenever the originating webhook event is known,
  // the full merged timeline is used instead so nothing is silently missing.
  let timeline: JournalEvent[] = [];
  let timelineError: string | null = null;
  try {
    timeline = webhookEventId
      ? await getWebhookEventTimeline(webhookEventId)
      : await getSetupTimeline(id);
  } catch (err) {
    timelineError = err instanceof ApiError ? err.message : "Failed to load setup timeline.";
  }

  // Whether a trade decision (executed or skipped) has already been
  // recorded against this Setup, derived from the timeline already fetched
  // above rather than a new list-by-setupId endpoint - see
  // journal-trades.ts's createJournalTrade/createAndRecordJournalTradeEntry,
  // both of which emit a TRADE_EXECUTED/TRADE_SKIPPED JournalEvent
  // correlated on the Setup's id with entityId set to the JournalTrade's
  // own id. Used only to decide which UI to show; the actual "already
  // executed" guard is enforced server-side (setup.service.ts#execute's
  // 409), this is purely a presentation shortcut.
  const recordedTradeIds = Array.from(
    new Set(
      timeline
        .filter(
          (event) =>
            (event.eventType === "TRADE_EXECUTED" || event.eventType === "TRADE_SKIPPED") &&
            event.entityType === "JOURNAL_TRADE",
        )
        .map((event) => event.entityId),
    ),
  );

  // Best-effort, same as screenshots/webhookEventId above.
  let notifications: NotificationDelivery[] = [];
  try {
    notifications = await getSetupNotifications(id);
  } catch {
    // Rendered as "no notifications" below - never fabricated.
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Setup</h1>
        <p className="muted">
          <Link href="/live-setups">&larr; back to live setups</Link>
        </p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Instrument</div>
            <div className="detail-item__value">{setup.instrumentId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Strategy</div>
            <div className="detail-item__value">{setup.strategyId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Strategy Version</div>
            <div className="detail-item__value">{setup.strategyVersionId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Timeframe</div>
            <div className="detail-item__value">{snapshot ? snapshot.timeframe : "unknown"}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Direction</div>
            <div className="detail-item__value">
              <DirectionBadge direction={setup.direction} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Source</div>
            <div className="detail-item__value">
              <SetupSourceBadge source={setup.source} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Status</div>
            <div className="detail-item__value">
              <SetupStatusBadge status={setup.status} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Bar Time</div>
            <div className="detail-item__value">
              {snapshot ? formatDateTime(snapshot.timestamp) : "unknown"}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Received (created)</div>
            <div className="detail-item__value">{formatDateTime(setup.createdAt)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Entry</div>
            <div className="detail-item__value">{formatDecimal(setup.plannedEntry, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Stop</div>
            <div className="detail-item__value">{plannedPriceValue(setup.plannedStop)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Target 1</div>
            <div className="detail-item__value">{plannedPriceValue(setup.plannedTarget1)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Target 2</div>
            <div className="detail-item__value">{plannedPriceValue(setup.plannedTarget2)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Expires</div>
            <div className="detail-item__value">
              {setup.expiresAt ? formatDateTime(setup.expiresAt) : "Not set"}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Updated</div>
            <div className="detail-item__value">{formatDateTime(setup.updatedAt)}</div>
          </div>
        </div>

        {setup.decisionSummary && (
          <div className="detail-grid detail-grid--spaced">
            <div className="detail-item detail-item--full">
              <div className="detail-item__label">Decision Summary</div>
              <div className="detail-item__value">{setup.decisionSummary}</div>
            </div>
          </div>
        )}

        {webhookEventId && (
          <p className="muted">
            Originating webhook delivery:{" "}
            <Link href={`/webhook-events/${webhookEventId}`}>{webhookEventId}</Link>
          </p>
        )}
      </div>

      <ScreenshotsSection owner={{ kind: "setup", setupId: id }} initialScreenshots={screenshots} />

      {setup.status === "READY" && recordedTradeIds.length === 0 && (
        <SetupActionsCard setupId={id} />
      )}

      {recordedTradeIds.length > 0 && (
        <div className="card">
          <h2>Trade Actions</h2>
          <p className="muted">
            {recordedTradeIds.length === 1
              ? "This setup already has a recorded trade decision: "
              : "This setup already has recorded trade decisions: "}
            {recordedTradeIds.map((tradeId, index) => (
              <span key={tradeId}>
                {index > 0 && ", "}
                <Link href={`/trades/${tradeId}`}>{tradeId}</Link>
              </span>
            ))}
          </p>
        </div>
      )}

      {setup.status !== "READY" && recordedTradeIds.length === 0 && (
        <div className="card">
          <h2>Trade Actions</h2>
          <div className="empty-state">
            Actions become available once this setup reaches READY.
          </div>
        </div>
      )}

      <div className="card">
        <h2>Notifications</h2>
        <NotificationsCard notifications={notifications} />
      </div>

      <div className="card">
        <h2>Timeline</h2>
        {timelineError && <div className="error-banner">{timelineError}</div>}
        {!timelineError && <EventTimeline events={timeline} />}
      </div>
    </div>
  );
}
