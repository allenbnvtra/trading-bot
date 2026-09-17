import type { BacktestMetrics } from "@/lib/api";
import {
  formatCurrency,
  formatInteger,
  formatPercent,
  formatPercentValue,
  formatProfitFactor,
  formatR,
  signOf,
} from "@/lib/format";

/**
 * Renders the headline backtest metrics. Every value here comes directly
 * from `BacktestMetrics` as returned by the API - nothing is recomputed.
 */
export default function StatGrid({ metrics }: { metrics: BacktestMetrics }) {
  const tiles: { label: string; value: string; sign?: "positive" | "negative" | "neutral" }[] = [
    { label: "Trades", value: formatInteger(metrics.totalTrades) },
    { label: "Win Rate", value: formatPercent(metrics.winRate) },
    { label: "Profit Factor", value: formatProfitFactor(metrics.profitFactor) },
    {
      label: "Net P&L",
      value: formatCurrency(metrics.netProfit),
      sign: signOf(metrics.netProfit),
    },
    {
      label: "Average R",
      value: formatR(metrics.averageR),
      sign: signOf(metrics.averageR),
    },
    {
      label: "Max Drawdown",
      value: `${formatCurrency(metrics.maxDrawdown)} (${formatPercentValue(metrics.maxDrawdownPercent)})`,
    },
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
