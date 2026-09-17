import Link from "next/link";
import {
  ApiError,
  getInstruments,
  getJournalTrades,
  getStrategies,
  type Direction,
  type ExecutionMode,
  type JournalTrade,
} from "@/lib/api";
import { getAllStrategyVersions } from "@/lib/strategy-versions";
import { formatCurrency, formatDateTime, formatDecimal, formatR, signOf } from "@/lib/format";
import { DirectionBadge, ExecutionModeBadge, JournalTradeStatusBadge } from "@/components/StatusBadge";
import FilterForm, { type FilterField } from "@/components/FilterForm";

const DIRECTIONS: Direction[] = ["LONG", "SHORT"];
const EXECUTION_MODES: ExecutionMode[] = ["BACKTEST", "PAPER", "MANUAL_LIVE", "SKIPPED"];

interface TradesSearchParams {
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  direction?: string;
  executionMode?: string;
  dateFrom?: string;
  dateTo?: string;
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<TradesSearchParams>;
}) {
  const params = await searchParams;

  let trades: JournalTrade[] = [];
  let loadError: string | null = null;
  let instrumentOptions: { value: string; label: string }[] = [];
  let strategyOptions: { value: string; label: string }[] = [];
  let strategyVersionOptions: { value: string; label: string }[] = [];

  try {
    const [instruments, strategies, strategyVersions, fetchedTrades] = await Promise.all([
      getInstruments(),
      getStrategies(),
      getAllStrategyVersions(),
      getJournalTrades({
        instrumentId: params.instrumentId,
        strategyId: params.strategyId,
        strategyVersionId: params.strategyVersionId,
        direction: params.direction as Direction | undefined,
        executionMode: params.executionMode as ExecutionMode | undefined,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      }),
    ]);

    instrumentOptions = instruments.map((instrument) => ({
      value: instrument.id,
      label: instrument.symbol,
    }));
    strategyOptions = strategies.map((strategy) => ({ value: strategy.id, label: strategy.name }));
    strategyVersionOptions = strategyVersions.map((version) => ({
      value: version.id,
      label: `${version.strategyName} - ${version.version}`,
    }));
    trades = fetchedTrades;
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load journal trades.";
  }

  const fields: FilterField[] = [
    { type: "select", name: "instrumentId", label: "Instrument", options: instrumentOptions },
    { type: "select", name: "strategyId", label: "Strategy", options: strategyOptions },
    {
      type: "select",
      name: "strategyVersionId",
      label: "Strategy Version",
      options: strategyVersionOptions,
    },
    {
      type: "select",
      name: "direction",
      label: "Direction",
      options: DIRECTIONS.map((direction) => ({ value: direction, label: direction })),
    },
    {
      type: "select",
      name: "executionMode",
      label: "Execution Mode",
      options: EXECUTION_MODES.map((mode) => ({ value: mode, label: mode })),
    },
    { type: "date", name: "dateFrom", label: "Date From" },
    { type: "date", name: "dateTo", label: "Date To" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>Trades</h1>
        <p>Journal trades: planned, executed, skipped, and closed - across every execution mode.</p>
      </div>

      <div className="card">
        <FilterForm fields={fields} values={params} />

        {loadError && <div className="error-banner">{loadError}</div>}

        {!loadError && trades.length === 0 && (
          <div className="empty-state">No journal trades match these filters.</div>
        )}

        {!loadError && trades.length > 0 && <JournalTradesTable trades={trades} />}
      </div>
    </div>
  );
}

function JournalTradesTable({ trades }: { trades: JournalTrade[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Direction</th>
            <th>Execution Mode</th>
            <th>Status</th>
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
            const entryIsActual = trade.actualEntry !== null;
            const entryValue = trade.actualEntry ?? trade.plannedEntry;

            return (
              <tr key={trade.id}>
                <td>
                  <Link href={`/trades/${trade.id}`}>{formatDateTime(trade.createdAt)}</Link>
                </td>
                <td>
                  <DirectionBadge direction={trade.direction} />
                </td>
                <td>
                  <ExecutionModeBadge mode={trade.executionMode} />
                </td>
                <td>
                  <JournalTradeStatusBadge status={trade.status} />
                </td>
                <td>
                  {formatDecimal(entryValue, 4)}{" "}
                  <span className="muted">({entryIsActual ? "actual" : "planned"})</span>
                </td>
                <td>{trade.actualExit !== null ? formatDecimal(trade.actualExit, 4) : "N/A"}</td>
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
