"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Backtest } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { BacktestStatusBadge } from "@/components/StatusBadge";

export interface BacktestListLabels {
  /** strategyVersionId -> "Strategy Name v1.0.0" */
  strategyVersionLabels: Record<string, string>;
  /** instrumentId -> "SYMBOL" */
  instrumentLabels: Record<string, string>;
}

export default function BacktestList({
  backtests,
  labels,
}: {
  backtests: Backtest[];
  labels: BacktestListLabels;
}) {
  if (backtests.length === 0) {
    return (
      <div className="empty-state">
        No backtests yet. Create one above to see strategy performance here.
      </div>
    );
  }

  const sorted = [...backtests].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Strategy Version</th>
            <th>Instrument</th>
            <th>Timeframe</th>
            <th>Date Range</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((backtest) => (
            <BacktestRow key={backtest.id} backtest={backtest} labels={labels} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BacktestRow({
  backtest,
  labels,
}: {
  backtest: Backtest;
  labels: BacktestListLabels;
}) {
  const router = useRouter();
  const href = `/research/${backtest.id}`;

  return (
    <tr className="row-link" onClick={() => router.push(href)}>
      <td>
        <Link href={href} onClick={(event) => event.stopPropagation()}>
          {formatDateTime(backtest.createdAt)}
        </Link>
      </td>
      <td>{labels.strategyVersionLabels[backtest.strategyVersionId] ?? backtest.strategyVersionId}</td>
      <td>{labels.instrumentLabels[backtest.instrumentId] ?? backtest.instrumentId}</td>
      <td>{backtest.timeframe}</td>
      <td>
        {formatDate(backtest.startDate)} &rarr; {formatDate(backtest.endDate)}
      </td>
      <td>
        <BacktestStatusBadge status={backtest.status} />
      </td>
    </tr>
  );
}
