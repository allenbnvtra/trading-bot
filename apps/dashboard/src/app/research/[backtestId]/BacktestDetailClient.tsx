"use client";

import { useEffect, useState } from "react";
import { getBacktest, getBacktestTrades, type BacktestTrade, type BacktestWithMetrics } from "@/lib/api";
import { formatDate, formatDateTime, formatDecimal, formatInteger } from "@/lib/format";
import { BacktestStatusBadge } from "@/components/StatusBadge";
import StatGrid from "@/components/StatGrid";
import TradesTable from "@/components/TradesTable";
import ResearchDisclaimer from "@/components/ResearchDisclaimer";

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

export default function BacktestDetailClient({
  backtestId,
  initialBacktest,
}: {
  backtestId: string;
  initialBacktest: BacktestWithMetrics;
}) {
  const [backtest, setBacktest] = useState<BacktestWithMetrics>(initialBacktest);
  const [pollError, setPollError] = useState<string | null>(null);
  const [trades, setTrades] = useState<BacktestTrade[] | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);

  // Poll while the backtest is still in flight, and stop once it reaches a
  // terminal state so we don't keep hitting the API forever.
  useEffect(() => {
    if (TERMINAL_STATUSES.has(backtest.status)) return;

    const interval = setInterval(() => {
      getBacktest(backtestId)
        .then((updated) => {
          setBacktest(updated);
          setPollError(null);
        })
        .catch((err) => {
          setPollError(err instanceof Error ? err.message : "Failed to refresh backtest status.");
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [backtest.status, backtestId]);

  // Load trades once the backtest has completed.
  useEffect(() => {
    if (backtest.status !== "COMPLETED") return;
    let cancelled = false;

    getBacktestTrades(backtestId)
      .then((data) => {
        if (!cancelled) setTrades(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setTradesError(err instanceof Error ? err.message : "Failed to load trades.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [backtest.status, backtestId]);

  const isTerminal = TERMINAL_STATUSES.has(backtest.status);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Backtest</h1>
        <p className="muted">{backtest.id}</p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Status</div>
            <div className="detail-item__value">
              <BacktestStatusBadge status={backtest.status} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Strategy Version</div>
            <div className="detail-item__value">{backtest.strategyVersionId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Instrument</div>
            <div className="detail-item__value">{backtest.instrumentId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Timeframe</div>
            <div className="detail-item__value">{backtest.timeframe}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Date Range</div>
            <div className="detail-item__value">
              {formatDate(backtest.startDate)} &rarr; {formatDate(backtest.endDate)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Initial Balance</div>
            <div className="detail-item__value">{formatDecimal(backtest.assumptions.initialBalance)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Risk %</div>
            <div className="detail-item__value">{backtest.assumptions.riskPercentage}%</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Slippage (ticks)</div>
            <div className="detail-item__value">{formatInteger(backtest.assumptions.slippageTicks)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Created</div>
            <div className="detail-item__value">{formatDateTime(backtest.createdAt)}</div>
          </div>
        </div>

        {!isTerminal && (
          <p className="muted">
            Watching for updates every {POLL_INTERVAL_MS / 1000}s...
            {pollError && <span className="error-banner inline-error">{pollError}</span>}
          </p>
        )}
      </div>

      {backtest.status === "FAILED" && (
        <div className="card">
          <h2>Failure</h2>
          <div className="error-banner">
            {backtest.errorMessage ?? "The backtest failed with no error message."}
          </div>
        </div>
      )}

      {backtest.status === "COMPLETED" && backtest.metrics && (
        <div className="card">
          <h2>Metrics</h2>
          <ResearchDisclaimer />
          <StatGrid metrics={backtest.metrics} />
        </div>
      )}

      {backtest.status === "COMPLETED" && (
        <div className="card">
          <h2>Trades</h2>
          {tradesError && <div className="error-banner">{tradesError}</div>}
          {!tradesError && trades === null && <p className="muted">Loading trades...</p>}
          {!tradesError && trades !== null && (
            <TradesTable backtestId={backtestId} trades={trades} />
          )}
        </div>
      )}
    </div>
  );
}
