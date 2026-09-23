import type { TradeAnalyticsMetrics } from "@/lib/api";
import {
  formatCurrency,
  formatDecimal,
  formatInteger,
  formatPercent,
  formatPercentValue,
  formatProfitFactor,
  formatR,
  signOf,
} from "@/lib/format";

/**
 * Renders the full `TradeAnalyticsMetrics` set. Every value comes directly
 * from the API - nothing here is derived or recomputed.
 */
export default function AnalyticsStatGrid({ metrics }: { metrics: TradeAnalyticsMetrics }) {
  const tiles: { label: string; value: string; sign?: "positive" | "negative" | "neutral" }[] = [
    { label: "Trades", value: formatInteger(metrics.tradeCount) },
    { label: "Win Rate", value: formatPercent(metrics.winRate) },
    { label: "Profit Factor", value: formatProfitFactor(metrics.profitFactor) },
    { label: "Net P&L", value: formatCurrency(metrics.netPnl), sign: signOf(metrics.netPnl) },
    { label: "Average R", value: formatR(metrics.averageR), sign: signOf(metrics.averageR) },
    {
      label: "Expectancy",
      value: formatCurrency(metrics.expectancy),
      sign: signOf(metrics.expectancy),
    },
    { label: "Average Winner", value: formatCurrency(metrics.averageWinner) },
    { label: "Average Loser", value: formatCurrency(metrics.averageLoser) },
    { label: "Largest Winner", value: formatCurrency(metrics.largestWinner) },
    { label: "Largest Loser", value: formatCurrency(metrics.largestLoser) },
    {
      label: "Max Drawdown",
      value: `${formatCurrency(metrics.maxDrawdown)} (${formatPercentValue(metrics.maxDrawdownPercent)})`,
    },
    {
      label: "Consecutive Wins / Losses",
      value: `${formatInteger(metrics.maximumConsecutiveWins)} / ${formatInteger(metrics.maximumConsecutiveLosses)}`,
    },
    { label: "Avg MFE (points)", value: formatDecimal(metrics.mfeAverage, 4) },
    { label: "Avg MAE (points)", value: formatDecimal(metrics.maeAverage, 4) },
    { label: "Total Fees", value: formatCurrency(metrics.totalFees) },
    { label: "Avg Slippage", value: formatCurrency(metrics.averageSlippage) },
  ];

  return (
    <div className="stat-grid">
      {tiles.map((tile) => (
        <div className="stat-tile" key={tile.label}>
          <div className="stat-tile__label">{tile.label}</div>
          <div
            className={
              tile.sign && tile.sign !== "neutral"
                ? `stat-tile__value stat-tile__value--${tile.sign}`
                : "stat-tile__value"
            }
          >
            {tile.value}
          </div>
        </div>
      ))}
    </div>
  );
}
