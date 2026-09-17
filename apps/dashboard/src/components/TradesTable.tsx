"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import type { BacktestTrade } from "@/lib/api";
import { formatCurrency, formatDateTime, formatDecimal, formatR, signOf } from "@/lib/format";
import { DirectionBadge } from "@/components/StatusBadge";

export default function TradesTable({
  backtestId,
  trades,
}: {
  backtestId: string;
  trades: BacktestTrade[];
}) {
  if (trades.length === 0) {
    return <div className="empty-state">No trades were produced by this backtest.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Direction</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>Target</th>
            <th>Exit</th>
            <th>P&amp;L</th>
            <th>R</th>
            <th>Exit reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <TradeRow key={trade.id} backtestId={backtestId} trade={trade} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeRow({ backtestId, trade }: { backtestId: string; trade: BacktestTrade }) {
  const router = useRouter();
  const pnlSign = signOf(trade.netPnl);
  const rSign = signOf(trade.rMultiple);
  const href = `/research/${backtestId}/trades/${trade.id}`;

  return (
    <tr className="row-link" onClick={() => router.push(href)}>
      <td>
        <Link href={href} onClick={(event) => event.stopPropagation()}>
          {formatDateTime(trade.entryTimestamp)}
        </Link>
      </td>
      <td>
        <DirectionBadge direction={trade.direction} />
      </td>
      <td>{formatDecimal(trade.entryPrice, 4)}</td>
      <td>{formatDecimal(trade.stopPrice, 4)}</td>
      <td>{formatDecimal(trade.targetPrice, 4)}</td>
      <td>{formatDecimal(trade.exitPrice, 4)}</td>
      <td className={pnlSign !== "neutral" ? `value-${pnlSign}` : undefined}>
        {formatCurrency(trade.netPnl)}
      </td>
      <td className={rSign !== "neutral" ? `value-${rSign}` : undefined}>
        {formatR(trade.rMultiple)}
      </td>
      <td>{trade.exitReason}</td>
    </tr>
  );
}
