"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  requestPostTradeScreenshot,
  requestPreTradeScreenshot,
  type TradeScreenshot,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { ScreenshotStatusBadge } from "./StatusBadge";

// Mirrors lib/api.ts's/lib/realtime.ts's own local NEXT_PUBLIC_API_BASE_URL
// convention - this file never imports @trading-copilot/shared-types (its
// CJS barrel transitively pulls in node:crypto via tradingview.ts, which
// breaks a browser bundle; see ChartRenderer.tsx for the same note).
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const SCREENSHOT_TYPE_LABELS: Record<TradeScreenshot["type"], string> = {
  PRE_TRADE: "Pre-Trade",
  POST_TRADE: "Post-Trade",
};

export interface ScreenshotCardProps {
  screenshots: TradeScreenshot[];
  onRetry: (screenshotId: string) => void;
}

/**
 * Pure presentational: renders whatever screenshot rows it's given and
 * forwards a "Retry" click for a FAILED row up to the caller. Never fetches
 * or mutates anything itself - see `ScreenshotsSection` below for the
 * state-owning wrapper each detail page actually renders.
 *
 * A FAILED row's failureCode/failureMessage are always shown, never hidden -
 * this is the one place in the dashboard a generation failure is surfaced.
 */
export default function ScreenshotCard({ screenshots, onRetry }: ScreenshotCardProps) {
  if (screenshots.length === 0) {
    return <div className="empty-state">No screenshots requested yet.</div>;
  }

  return (
    <div className="screenshot-list">
      {screenshots.map((screenshot) => (
        <div key={screenshot.id} className="card card--nested">
          <div className="detail-grid">
            <div className="detail-item">
              <div className="detail-item__label">Type</div>
              <div className="detail-item__value">{SCREENSHOT_TYPE_LABELS[screenshot.type]}</div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Status</div>
              <div className="detail-item__value">
                <ScreenshotStatusBadge status={screenshot.status} />
              </div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Chart Config Version</div>
              <div className="detail-item__value">{screenshot.chartConfigVersion}</div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Rendered</div>
              <div className="detail-item__value">{formatDateTime(screenshot.renderedAt)}</div>
            </div>
          </div>

          {screenshot.status === "READY" && (
            <a
              href={`${API_BASE_URL}/screenshots/${screenshot.id}/image`}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={`${API_BASE_URL}/screenshots/${screenshot.id}/image`}
                alt={`${SCREENSHOT_TYPE_LABELS[screenshot.type]} chart screenshot`}
                className="screenshot-image"
              />
            </a>
          )}

          {(screenshot.status === "REQUESTED" || screenshot.status === "GENERATING") && (
            <div className="note-banner">Generating...</div>
          )}

          {screenshot.status === "FAILED" && (
            <div>
              <div className="error-banner">
                {screenshot.failureCode ? `${screenshot.failureCode}: ` : ""}
                {screenshot.failureMessage ?? "Screenshot generation failed; no further detail was recorded."}
              </div>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => onRetry(screenshot.id)}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export type ScreenshotOwner =
  | { kind: "setup"; setupId: string }
  | { kind: "trade"; tradeId: string };

/**
 * The state-owning wrapper both `/setups/[id]` and `/trades/[id]` render.
 * Those are Server Components (they fetch the Setup/JournalTrade itself,
 * plus this list's initial value, server-side) that cannot hold a retry
 * callback's client-side state themselves - a function prop cannot cross the
 * server/client boundary - so this small client component is what actually
 * owns the screenshots list and wires `onRetry` to the correct idempotent-safe
 * endpoint (Task 5/10's requestPreTradeScreenshot/requestPostTradeScreenshot,
 * never a new one) before handing off to the pure `ScreenshotCard` above.
 */
export function ScreenshotsSection({
  owner,
  initialScreenshots,
}: {
  owner: ScreenshotOwner;
  initialScreenshots: TradeScreenshot[];
}) {
  const [screenshots, setScreenshots] = useState<TradeScreenshot[]>(initialScreenshots);
  const [retryError, setRetryError] = useState<string | null>(null);

  const handleRetry = useCallback(
    (_screenshotId: string) => {
      // The retry request always targets the current CHART_CONFIG_VERSION
      // idempotency key (setupId/tradeId + type), not a specific historical
      // row id - there is normally only one row per type anyway. The id is
      // still part of the public onRetry contract (ScreenshotCard's props)
      // in case a future chartConfigVersion bump ever shows more than one.
      setRetryError(null);
      const request =
        owner.kind === "setup"
          ? requestPreTradeScreenshot(owner.setupId)
          : requestPostTradeScreenshot(owner.tradeId);

      request
        .then((updated) => {
          setScreenshots((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        })
        .catch((err) => {
          setRetryError(
            err instanceof ApiError ? err.message : "Failed to retry screenshot generation.",
          );
        });
    },
    [owner],
  );

  return (
    <div className="card">
      <h2>Screenshots</h2>
      {retryError && <div className="error-banner">{retryError}</div>}
      <ScreenshotCard screenshots={screenshots} onRetry={handleRetry} />
    </div>
  );
}
