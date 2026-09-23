import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ApiError,
  getAnalyticsStrategyVersionDetail,
  type GroupComparisonStats,
  type NormalizedTrade,
  type TradeAnalyticsMetrics,
} from "@/lib/api";
import {
  formatCurrency,
  formatDecimal,
  formatPercent,
  formatProfitFactor,
  formatR,
  signOf,
} from "@/lib/format";
import { DirectionBadge, ExecutionModeBadge, TradeSourceBadge } from "@/components/StatusBadge";
import AnalyticsStatGrid from "@/components/AnalyticsStatGrid";
import AnalyticsDisclaimer from "@/components/AnalyticsDisclaimer";

export default async function AnalyticsStrategyVersionPage({
  params,
}: {
  params: Promise<{ strategyId: string; versionId: string }>;
}) {
  const { strategyId, versionId } = await params;

  let detail;
  try {
    detail = await getAnalyticsStrategyVersionDetail(strategyId, versionId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load strategy analytics.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Strategy Version Analytics</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  const { metrics, byDirection, winnersLosers, trades } = detail;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Strategy Version Analytics</h1>
        <p className="muted">
          <Link href="/analytics">&larr; back to analytics</Link>
        </p>
        <p className="muted">
          {strategyId} / {versionId}
        </p>
      </div>

      <AnalyticsDisclaimer />

      <div className="card">
        <h2>Overall</h2>
        <AnalyticsStatGrid metrics={metrics} />
      </div>

      <div className="card">
        <h2>Long vs Short</h2>
        <DirectionComparison byDirection={byDirection} />
      </div>

      <div className="card">
        <h2>Winners vs Losers vs All</h2>
        <WinnersLosersTable winnersLosers={winnersLosers} />
      </div>

      <div className="card">
        <h2>Trades</h2>
        {trades.length === 0 ? (
          <div className="empty-state">No trades contribute to this strategy version yet.</div>
        ) : (
          <NormalizedTradesTable trades={trades} />
        )}
      </div>
    </div>
  );
}

function DirectionComparison({
  byDirection,
}: {
  byDirection: { LONG: TradeAnalyticsMetrics; SHORT: TradeAnalyticsMetrics };
}) {
  return (
    <div className="comparison-grid">
      {(["LONG", "SHORT"] as const).map((direction) => {
        const metrics = byDirection[direction];
        const pnlSign = signOf(metrics.netPnl);
        return (
          <div className="card card--nested" key={direction}>
            <DirectionBadge direction={direction} />
            <div className="detail-grid detail-grid--spaced">
              <div className="detail-item">
                <div className="detail-item__label">Trades</div>
                <div className="detail-item__value">{metrics.tradeCount}</div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Win Rate</div>
                <div className="detail-item__value">{formatPercent(metrics.winRate)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Net P&amp;L</div>
                <div
                  className={`detail-item__value ${pnlSign !== "neutral" ? `value-${pnlSign}` : ""}`}
                >
                  {formatCurrency(metrics.netPnl)}
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Average R</div>
                <div className="detail-item__value">{formatR(metrics.averageR)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Profit Factor</div>
                <div className="detail-item__value">{formatProfitFactor(metrics.profitFactor)}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WinnersLosersTable({
  winnersLosers,
}: {
  winnersLosers: { winners: GroupComparisonStats; losers: GroupComparisonStats; allTrades: GroupComparisonStats };
}) {
  const rows: { label: string; stats: GroupComparisonStats }[] = [
    { label: "Winners", stats: winnersLosers.winners },
    { label: "Losers", stats: winnersLosers.losers },
    { label: "All Trades", stats: winnersLosers.allTrades },
  ];

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th>Sample Size</th>
            <th>Win Rate</th>
            <th>Average R</th>
            <th>Profit Factor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.stats.sampleSize}</td>
              <td>{formatPercent(row.stats.winRate)}</td>
              <td>{formatR(row.stats.averageR)}</td>
              <td>{formatProfitFactor(row.stats.profitFactor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NormalizedTradesTable({ trades }: { trades: NormalizedTrade[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Direction</th>
            <th>Execution Mode</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>Net P&amp;L</th>
            <th>R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const pnlSign = signOf(trade.netPnl);
            const rSign = signOf(trade.rMultiple);
            return (
              <tr key={`${trade.source}-${trade.id}`}>
                <td>
                  <TradeSourceBadge source={trade.source} />
                </td>
                <td>
                  <DirectionBadge direction={trade.direction} />
                </td>
                <td>
                  <ExecutionModeBadge mode={trade.executionMode} />
                </td>
                <td>{formatDecimal(trade.entryPrice, 4)}</td>
                <td>{formatDecimal(trade.exitPrice, 4)}</td>
                <td className={pnlSign !== "neutral" ? `value-${pnlSign}` : undefined}>
                  {formatCurrency(trade.netPnl)}
                </td>
                <td className={rSign !== "neutral" ? `value-${rSign}` : undefined}>
                  {formatR(trade.rMultiple)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
