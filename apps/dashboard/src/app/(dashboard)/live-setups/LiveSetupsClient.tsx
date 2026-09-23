"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getMarketSnapshot,
  getSetup,
  getSetupScreenshots,
  getSetups,
  type MarketSnapshot,
  type RealtimeEvent,
  type Setup,
  type TradeScreenshot,
} from "@/lib/api";
import { formatDateTime, formatDecimal } from "@/lib/format";
import { useRealtimeEvents } from "@/lib/realtime";
import { DirectionBadge, ScreenshotStatusBadge, SetupSourceBadge, SetupStatusBadge } from "@/components/StatusBadge";
import ConnectionIndicator from "@/components/ConnectionIndicator";

// Mirrors lib/api.ts's/lib/realtime.ts's own local NEXT_PUBLIC_API_BASE_URL
// convention (see ScreenshotCard.tsx for the fuller note on why this file
// never imports @trading-copilot/shared-types instead).
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * Live TradingView-sourced Setups. Update strategy (documented per the
 * milestone task, since either choice is defensible for a small personal
 * list): on a setup.* realtime event, re-fetch and merge only that one
 * Setup (and its MarketSnapshot, if not already cached) rather than
 * refetching the whole list - this list is small, but a per-row merge
 * avoids a full-table flicker every time any Setup changes and is barely
 * more code than a full refetch. On WebSocket reconnect, always refetch the
 * full list from the REST API (docs/architecture.md: a reconnecting client
 * never trusts it saw every message while disconnected).
 *
 * webhook.received events are intentionally ignored here: they fire before
 * a Setup exists (or ever will, if the delivery is rejected) and carry no
 * setupId, so there is nothing to merge into this table. System health
 * (including "last webhook received") is shown by HealthIndicator above.
 */
export default function LiveSetupsClient({
  initialSetups,
  initialSnapshots,
  instrumentLabels,
  strategyVersionLabels,
}: {
  initialSetups: Setup[];
  initialSnapshots: Record<string, MarketSnapshot>;
  instrumentLabels: Record<string, string>;
  strategyVersionLabels: Record<string, string>;
}) {
  const router = useRouter();
  const [setups, setSetups] = useState<Setup[]>(initialSetups);
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>(initialSnapshots);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Tracks marketSnapshotIds currently being fetched so a burst of events for
  // the same Setup (or several Setups sharing a snapshot) never fires
  // duplicate requests for the same id.
  const pendingSnapshotIds = useRef<Set<string>>(new Set());

  const ensureSnapshot = useCallback((marketSnapshotId: string) => {
    setSnapshots((current) => {
      if (current[marketSnapshotId] || pendingSnapshotIds.current.has(marketSnapshotId)) {
        return current;
      }
      pendingSnapshotIds.current.add(marketSnapshotId);
      getMarketSnapshot(marketSnapshotId)
        .then((snapshot) => {
          setSnapshots((prev) => ({ ...prev, [snapshot.id]: snapshot }));
        })
        .catch(() => {
          // Missing snapshot context renders as "unknown" below; never fabricated.
        })
        .finally(() => {
          pendingSnapshotIds.current.delete(marketSnapshotId);
        });
      return current;
    });
  }, []);

  // Lazily fetches the PRE_TRADE screenshot (if any) for one Setup, mirroring
  // ensureSnapshot's exact caching/dedup strategy above (a ref of in-flight
  // ids plus a functional setState check-then-fetch) rather than a second,
  // different caching approach for this one column. Keyed by setupId, not
  // marketSnapshotId, since a screenshot's idempotency key is
  // (setupId, type, chartConfigVersion).
  const [preTradeScreenshots, setPreTradeScreenshots] = useState<
    Record<string, TradeScreenshot | null>
  >({});
  const pendingScreenshotSetupIds = useRef<Set<string>>(new Set());

  const ensureScreenshot = useCallback((setupId: string) => {
    setPreTradeScreenshots((current) => {
      if (setupId in current || pendingScreenshotSetupIds.current.has(setupId)) {
        return current;
      }
      pendingScreenshotSetupIds.current.add(setupId);
      getSetupScreenshots(setupId)
        .then((screenshots) => {
          const preTrade = screenshots.find((screenshot) => screenshot.type === "PRE_TRADE") ?? null;
          setPreTradeScreenshots((prev) => ({ ...prev, [setupId]: preTrade }));
        })
        .catch(() => {
          // Missing screenshot context renders as "no screenshot" below;
          // never fabricated.
        })
        .finally(() => {
          pendingScreenshotSetupIds.current.delete(setupId);
        });
      return current;
    });
  }, []);

  const handleRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.type === "webhook.received") return;

      getSetup(event.setupId)
        .then((setup) => {
          // This page only ever shows TRADINGVIEW-sourced Setups; a setup.*
          // event for any other source (e.g. a manual PATCH /setups/:id/status
          // action on a MANUAL_TEST setup) is simply not this list's concern.
          if (setup.source !== "TRADINGVIEW") return;

          setSetups((prev) => {
            const withoutOld = prev.filter((existing) => existing.id !== setup.id);
            return [setup, ...withoutOld].sort(
              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
            );
          });
          void ensureSnapshot(setup.marketSnapshotId);
          // A screenshot's status is mutable over time (unlike a
          // MarketSnapshot, which is immutable once created) - e.g. a
          // setup.updated event landing this Setup on READY is exactly when
          // pre-trade screenshot generation gets triggered server-side. Drop
          // any cached entry so the effect below re-fetches it, instead of
          // leaving a stale "no screenshot"/status cached forever.
          setPreTradeScreenshots((prev) => {
            if (!(setup.id in prev)) return prev;
            const { [setup.id]: _removed, ...rest } = prev;
            return rest;
          });
          setSyncError(null);
        })
        .catch((err) => {
          setSyncError(err instanceof Error ? err.message : "Failed to sync a live setup update.");
        });
    },
    [ensureSnapshot],
  );

  const handleReconnect = useCallback(() => {
    getSetups({ source: "TRADINGVIEW" })
      .then(async (fetched) => {
        setSetups(fetched);
        const uniqueIds = [...new Set(fetched.map((setup) => setup.marketSnapshotId))];
        const fetchedSnapshots = await Promise.all(
          uniqueIds.map((id) => getMarketSnapshot(id).catch(() => null)),
        );
        const byId: Record<string, MarketSnapshot> = {};
        for (const snapshot of fetchedSnapshots) {
          if (snapshot) byId[snapshot.id] = snapshot;
        }
        setSnapshots(byId);
        setSyncError(null);
      })
      .catch((err) => {
        setSyncError(
          err instanceof Error ? err.message : "Failed to reload live setups after reconnecting.",
        );
      });
  }, []);

  const connectionState = useRealtimeEvents(handleRealtimeEvent, handleReconnect);

  const sortedSetups = useMemo(
    () =>
      [...setups].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [setups],
  );

  // Triggers the lazy per-row screenshot fetch for every currently-known
  // Setup (initial load, reconnect refetch, and any new/updated row) -
  // ensureScreenshot's own dedup guards against refetching an id already
  // cached or already in flight.
  useEffect(() => {
    for (const setup of sortedSetups) {
      ensureScreenshot(setup.id);
    }
  }, [sortedSetups, ensureScreenshot]);

  return (
    <div className="card">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>TradingView Setups</h2>
        <ConnectionIndicator state={connectionState} />
      </div>

      {syncError && <div className="error-banner inline-error">{syncError}</div>}

      {sortedSetups.length === 0 && (
        <div className="empty-state">
          No TradingView-sourced setups yet. Fire a webhook alert to see one appear here live.
        </div>
      )}

      {sortedSetups.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Direction</th>
                <th>Strategy</th>
                <th>Timeframe</th>
                <th>Status</th>
                <th>Bar Time</th>
                <th>Received</th>
                <th>Planned Entry</th>
                <th>Expires</th>
                <th>Source</th>
                <th>Screenshot</th>
              </tr>
            </thead>
            <tbody>
              {sortedSetups.map((setup) => {
                const snapshot = snapshots[setup.marketSnapshotId] ?? null;
                const screenshot = preTradeScreenshots[setup.id];
                const href = `/setups/${setup.id}`;
                return (
                  <tr key={setup.id} className="row-link" onClick={() => router.push(href)}>
                    <td>
                      <Link href={href} onClick={(event) => event.stopPropagation()}>
                        {instrumentLabels[setup.instrumentId] ?? setup.instrumentId}
                      </Link>
                    </td>
                    <td>
                      <DirectionBadge direction={setup.direction} />
                    </td>
                    <td>{strategyVersionLabels[setup.strategyVersionId] ?? setup.strategyVersionId}</td>
                    <td>{snapshot ? snapshot.timeframe : "unknown"}</td>
                    <td>
                      <SetupStatusBadge status={setup.status} />
                    </td>
                    <td>{snapshot ? formatDateTime(snapshot.timestamp) : "unknown"}</td>
                    <td>{formatDateTime(setup.createdAt)}</td>
                    <td>{formatDecimal(setup.plannedEntry, 4)}</td>
                    <td>{setup.expiresAt ? formatDateTime(setup.expiresAt) : "not set"}</td>
                    <td>
                      <SetupSourceBadge source={setup.source} />
                    </td>
                    <td>
                      {screenshot === undefined && <span className="muted">loading...</span>}
                      {screenshot === null && <span className="muted">none</span>}
                      {screenshot && screenshot.status === "READY" && (
                        <img
                          src={`${API_BASE_URL}/screenshots/${screenshot.id}/image`}
                          alt="Pre-trade chart screenshot thumbnail"
                          className="screenshot-thumb"
                        />
                      )}
                      {screenshot && screenshot.status !== "READY" && (
                        <ScreenshotStatusBadge status={screenshot.status} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
