import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiError, getBacktest, getBacktestTrade } from "@/lib/api";
import {
  formatCurrency,
  formatDateTime,
  formatDecimal,
  formatInteger,
  formatR,
  signOf,
} from "@/lib/format";
import { DirectionBadge } from "@/components/StatusBadge";
import SurroundingCandlesTable from "@/components/SurroundingCandlesTable";

export default async function TradeDetailPage({
  params,
}: {
  params: Promise<{ backtestId: string; tradeId: string }>;
}) {
  const { backtestId, tradeId } = await params;

  let detail;
  let timeframe: string | null = null;
  try {
    const [tradeDetail, backtest] = await Promise.all([
      getBacktestTrade(backtestId, tradeId),
      getBacktest(backtestId),
    ]);
    detail = tradeDetail;
    timeframe = backtest.timeframe;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load trade.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Trade</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  const { trade, surroundingCandles } = detail;
  const pnlSign = signOf(trade.netPnl);
  const rSign = signOf(trade.rMultiple);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Trade Detail</h1>
        <p className="muted">
          <Link href={`/research/${backtestId}`}>&larr; back to backtest</Link>
        </p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Instrument</div>
            <div className="detail-item__value">{trade.instrumentId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Strategy Version</div>
            <div className="detail-item__value">{trade.strategyVersionId}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Timeframe</div>
            <div className="detail-item__value">{timeframe ?? "N/A"}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Direction</div>
            <div className="detail-item__value">
              <DirectionBadge direction={trade.direction} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Signal Timestamp</div>
            <div className="detail-item__value">{formatDateTime(trade.signalTimestamp)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Entry Timestamp</div>
            <div className="detail-item__value">{formatDateTime(trade.entryTimestamp)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Entry Price</div>
            <div className="detail-item__value">{formatDecimal(trade.entryPrice, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Stop Price</div>
            <div className="detail-item__value">{formatDecimal(trade.stopPrice, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Target Price</div>
            <div className="detail-item__value">{formatDecimal(trade.targetPrice, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Exit Timestamp</div>
            <div className="detail-item__value">{formatDateTime(trade.exitTimestamp)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Exit Price</div>
            <div className="detail-item__value">{formatDecimal(trade.exitPrice, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Exit Reason</div>
            <div className="detail-item__value">{trade.exitReason}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Quantity</div>
            <div className="detail-item__value">{formatInteger(trade.quantity)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Fees</div>
            <div className="detail-item__value">{formatCurrency(trade.fees)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Net P&amp;L</div>
            <div className={`detail-item__value ${pnlSign !== "neutral" ? `value-${pnlSign}` : ""}`}>
              {formatCurrency(trade.netPnl)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Risk Amount</div>
            <div className="detail-item__value">{formatCurrency(trade.riskAmount)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">R Multiple</div>
            <div className={`detail-item__value ${rSign !== "neutral" ? `value-${rSign}` : ""}`}>
              {formatR(trade.rMultiple)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">MFE</div>
            <div className="detail-item__value">{formatDecimal(trade.maximumFavorableExcursion, 4)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">MAE</div>
            <div className="detail-item__value">{formatDecimal(trade.maximumAdverseExcursion, 4)}</div>
          </div>
        </div>
        <p className="muted">{trade.entryReason}</p>
      </div>

      <div className="card">
        <h2>Surrounding Candles</h2>
        <SurroundingCandlesTable
          candles={surroundingCandles}
          entryTimestamp={trade.entryTimestamp}
          exitTimestamp={trade.exitTimestamp}
        />
      </div>
    </div>
  );
}
