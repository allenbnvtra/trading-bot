import Link from "next/link";
import { ApiError, getAnalyticsStrategies } from "@/lib/api";
import {
  formatCurrency,
  formatInteger,
  formatPercent,
  formatProfitFactor,
  formatR,
  signOf,
} from "@/lib/format";

export default async function AnalyticsPage() {
  let groups: Awaited<ReturnType<typeof getAnalyticsStrategies>> = [];
  let loadError: string | null = null;

  try {
    groups = await getAnalyticsStrategies();
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load strategy analytics.";
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Analytics</h1>
        <p>Deterministic performance analytics, one row per strategy version - never merged across versions.</p>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {!loadError && groups.length === 0 && (
        <div className="empty-state">No strategy analytics available yet.</div>
      )}

      {!loadError && groups.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Version</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>Average R</th>
                <th>Expectancy</th>
                <th>Profit Factor</th>
                <th>Net P&amp;L</th>
                <th>Max Drawdown</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const { metrics } = group;
                const pnlSign = signOf(metrics.netPnl);
                const strategyLabel = group.strategyName ?? group.strategyId ?? "N/A";
                const versionLabel = group.version ?? group.strategyVersionId ?? "N/A";
                const canLink = group.strategyId !== null && group.strategyVersionId !== null;
                const key = `${group.strategyId ?? "unknown"}:${group.strategyVersionId ?? "unknown"}`;

                return (
                  <tr key={key}>
                    <td>
                      {canLink ? (
                        <Link href={`/analytics/${group.strategyId}/${group.strategyVersionId}`}>
                          {strategyLabel}
                        </Link>
                      ) : (
                        strategyLabel
                      )}
                    </td>
                    <td>{versionLabel}</td>
                    <td>{formatInteger(metrics.tradeCount)}</td>
                    <td>{formatPercent(metrics.winRate)}</td>
                    <td>{formatR(metrics.averageR)}</td>
                    <td>{formatCurrency(metrics.expectancy)}</td>
                    <td>{formatProfitFactor(metrics.profitFactor)}</td>
                    <td className={pnlSign !== "neutral" ? `value-${pnlSign}` : undefined}>
                      {formatCurrency(metrics.netPnl)}
                    </td>
                    <td>{formatCurrency(metrics.maxDrawdown)}</td>
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
