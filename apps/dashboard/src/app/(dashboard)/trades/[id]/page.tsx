import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ApiError,
  getJournalTrade,
  getSetupTimeline,
  getTradeScreenshots,
  type JournalEvent,
  type TradeScreenshot,
} from "@/lib/api";
import { formatCurrency, formatDateTime, formatDecimal, formatR, signOf } from "@/lib/format";
import {
  DirectionBadge,
  ExecutionModeBadge,
  JournalTradeStatusBadge,
  OutcomeBadge,
} from "@/components/StatusBadge";
import EventTimeline from "@/components/EventTimeline";
import { ScreenshotsSection } from "@/components/ScreenshotCard";
import CloseTradeCard from "@/components/CloseTradeCard";

const NOT_ENOUGH_CANDLE_DATA = "Not enough candle data";

export default async function JournalTradeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let trade;
  try {
    trade = await getJournalTrade(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load journal trade.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Trade</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  let timeline: JournalEvent[] | null = null;
  let timelineError: string | null = null;
  if (trade.setupId) {
    try {
      timeline = await getSetupTimeline(trade.setupId);
    } catch (err) {
      timelineError = err instanceof ApiError ? err.message : "Failed to load setup timeline.";
    }
  }

  // Best-effort, same as the timeline fetch above: a screenshots-fetch
  // failure never blocks rendering the trade itself.
  let screenshots: TradeScreenshot[] = [];
  try {
    screenshots = await getTradeScreenshots(id);
  } catch {
    // Rendered as "no screenshots" below - never fabricated.
  }

  const pnlSign = signOf(trade.netPnl);
  const rSign = signOf(trade.rMultiple);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Journal Trade</h1>
        <p className="muted">
          <Link href="/trades">&larr; back to trades</Link>
        </p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Instrument</div>
            <div className="detail-item__value">{trade.instrumentId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Strategy</div>
            <div className="detail-item__value">{trade.strategyId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Strategy Version</div>
            <div className="detail-item__value">{trade.strategyVersionId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Direction</div>
            <div className="detail-item__value">
              <DirectionBadge direction={trade.direction} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Execution Mode</div>
            <div className="detail-item__value">
              <ExecutionModeBadge mode={trade.executionMode} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Status</div>
            <div className="detail-item__value">
              <JournalTradeStatusBadge status={trade.status} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Outcome</div>
            <div className="detail-item__value">
              {trade.outcome ? <OutcomeBadge outcome={trade.outcome} /> : "N/A"}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Entry</div>
            <div className="detail-item__value">{formatDecimal(trade.plannedEntry, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Actual Entry</div>
            <div className="detail-item__value">{formatDecimal(trade.actualEntry, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Stop</div>
            <div className="detail-item__value">{formatDecimal(trade.plannedStop, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Target 1</div>
            <div className="detail-item__value">{formatDecimal(trade.plannedTarget1, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Target 2</div>
            <div className="detail-item__value">{formatDecimal(trade.plannedTarget2, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Actual Exit</div>
            <div className="detail-item__value">{formatDecimal(trade.actualExit, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Entry Timestamp</div>
            <div className="detail-item__value">{formatDateTime(trade.entryTimestamp)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Exit Timestamp</div>
            <div className="detail-item__value">{formatDateTime(trade.exitTimestamp)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Quantity</div>
            <div className="detail-item__value">{trade.quantity ?? "N/A"}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Planned Risk</div>
            <div className="detail-item__value">{formatCurrency(trade.plannedRisk)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Estimated Fees</div>
            <div className="detail-item__value">{formatCurrency(trade.estimatedFees)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Actual Fees</div>
            <div className="detail-item__value">{formatCurrency(trade.actualFees)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Estimated Slippage</div>
            <div className="detail-item__value">{formatDecimal(trade.estimatedSlippage, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Actual Slippage</div>
            <div className="detail-item__value">{formatDecimal(trade.actualSlippage, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Gross P&amp;L</div>
            <div className="detail-item__value">{formatCurrency(trade.grossPnl)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Net P&amp;L</div>
            <div className={`detail-item__value ${pnlSign !== "neutral" ? `value-${pnlSign}` : ""}`}>
              {formatCurrency(trade.netPnl)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">R Multiple</div>
            <div className={`detail-item__value ${rSign !== "neutral" ? `value-${rSign}` : ""}`}>
              {formatR(trade.rMultiple)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">MFE</div>
            <div className="detail-item__value">
              {trade.mfe !== null
                ? formatCurrency(trade.mfe)
                : trade.status === "CLOSED"
                  ? NOT_ENOUGH_CANDLE_DATA
                  : "N/A"}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">MAE</div>
            <div className="detail-item__value">
              {trade.mae !== null
                ? formatCurrency(trade.mae)
                : trade.status === "CLOSED"
                  ? NOT_ENOUGH_CANDLE_DATA
                  : "N/A"}
            </div>
          </div>
        </div>

        {(trade.entryNotes || trade.exitNotes) && (
          <div className="detail-grid detail-grid--spaced">
            {trade.entryNotes && (
              <div className="detail-item detail-item--full">
                <div className="detail-item__label">Entry Notes</div>
                <div className="detail-item__value">{trade.entryNotes}</div>
              </div>
            )}
            {trade.exitNotes && (
              <div className="detail-item detail-item--full">
                <div className="detail-item__label">Exit Notes</div>
                <div className="detail-item__value">{trade.exitNotes}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {trade.status === "OPEN" && <CloseTradeCard tradeId={id} />}

      <ScreenshotsSection owner={{ kind: "trade", tradeId: id }} initialScreenshots={screenshots} />

      {trade.setupId && (
        <div className="card">
          <h2>Setup Timeline</h2>
          {timelineError && <div className="error-banner">{timelineError}</div>}
          {!timelineError && timeline && <EventTimeline events={timeline} />}
        </div>
      )}
    </div>
  );
}
