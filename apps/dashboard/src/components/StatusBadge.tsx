import type { BacktestStatus, Direction } from "@/lib/api";

const STATUS_CLASS: Record<BacktestStatus, string> = {
  QUEUED: "badge--queued",
  RUNNING: "badge--running",
  COMPLETED: "badge--completed",
  FAILED: "badge--failed",
};

export function BacktestStatusBadge({ status }: { status: BacktestStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{status}</span>;
}

const DIRECTION_CLASS: Record<Direction, string> = {
  LONG: "badge--long",
  SHORT: "badge--short",
};

export function DirectionBadge({ direction }: { direction: Direction }) {
  return <span className={`badge ${DIRECTION_CLASS[direction]}`}>{direction}</span>;
}
