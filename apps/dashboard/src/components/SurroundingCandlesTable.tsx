import type { Candle } from "@/lib/api";
import { formatDateTime, formatDecimal } from "@/lib/format";

export default function SurroundingCandlesTable({
  candles,
  entryTimestamp,
  exitTimestamp,
}: {
  candles: Candle[];
  entryTimestamp: string;
  exitTimestamp: string;
}) {
  if (candles.length === 0) {
    return <div className="empty-state">No surrounding candle data available.</div>;
  }

  const entryTime = new Date(entryTimestamp).getTime();
  const exitTime = new Date(exitTimestamp).getTime();

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Open</th>
            <th>High</th>
            <th>Low</th>
            <th>Close</th>
            <th>Volume</th>
          </tr>
        </thead>
        <tbody>
          {candles.map((candle) => {
            const candleTime = new Date(candle.timestamp).getTime();
            const isEntry = candleTime === entryTime;
            const isExit = candleTime === exitTime;
            const className = isEntry
              ? "candle-highlight-entry"
              : isExit
                ? "candle-highlight-exit"
                : undefined;
            return (
              <tr key={candle.id} className={className}>
                <td>
                  {formatDateTime(candle.timestamp)}
                  {isEntry && " (entry)"}
                  {isExit && " (exit)"}
                </td>
                <td>{formatDecimal(candle.open, 4)}</td>
                <td>{formatDecimal(candle.high, 4)}</td>
                <td>{formatDecimal(candle.low, 4)}</td>
                <td>{formatDecimal(candle.close, 4)}</td>
                <td>{formatDecimal(candle.volume, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
