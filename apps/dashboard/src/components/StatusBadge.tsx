import type {
  BacktestStatus,
  Direction,
  ExecutionMode,
  JournalEventType,
  JournalTradeStatus,
  NormalizedTradeSource,
  SetupStatus,
} from "@/lib/api";

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

const SETUP_STATUS_CLASS: Record<SetupStatus, string> = {
  WATCH: "badge--neutral",
  PREPARE: "badge--info",
  READY: "badge--success",
  REJECTED: "badge--danger",
  INVALIDATED: "badge--danger",
  EXPIRED: "badge--neutral",
};

export function SetupStatusBadge({ status }: { status: SetupStatus }) {
  return <span className={`badge ${SETUP_STATUS_CLASS[status]}`}>{status}</span>;
}

const JOURNAL_TRADE_STATUS_CLASS: Record<JournalTradeStatus, string> = {
  PLANNED: "badge--neutral",
  OPEN: "badge--info",
  CLOSED: "badge--success",
  SKIPPED: "badge--neutral",
};

export function JournalTradeStatusBadge({ status }: { status: JournalTradeStatus }) {
  return <span className={`badge ${JOURNAL_TRADE_STATUS_CLASS[status]}`}>{status}</span>;
}

const EXECUTION_MODE_CLASS: Record<ExecutionMode, string> = {
  BACKTEST: "badge--neutral",
  PAPER: "badge--info",
  MANUAL_LIVE: "badge--warning",
  SKIPPED: "badge--neutral",
};

export function ExecutionModeBadge({ mode }: { mode: ExecutionMode }) {
  return <span className={`badge ${EXECUTION_MODE_CLASS[mode]}`}>{mode}</span>;
}

const TRADE_SOURCE_CLASS: Record<NormalizedTradeSource, string> = {
  BACKTEST: "badge--neutral",
  JOURNAL: "badge--info",
};

export function TradeSourceBadge({ source }: { source: NormalizedTradeSource }) {
  return <span className={`badge ${TRADE_SOURCE_CLASS[source]}`}>{source}</span>;
}

const EVENT_TYPE_CLASS: Record<JournalEventType, string> = {
  SETUP_CREATED: "badge--neutral",
  STRATEGY_EVALUATED: "badge--info",
  RISK_CALCULATED: "badge--info",
  SETUP_APPROVED: "badge--success",
  SETUP_REJECTED: "badge--danger",
  SETUP_INVALIDATED: "badge--danger",
  SETUP_EXPIRED: "badge--neutral",
  TRADE_READY: "badge--info",
  TRADE_EXECUTED: "badge--success",
  TRADE_SKIPPED: "badge--neutral",
  TRADE_CLOSED: "badge--success",
  POST_TRADE_ANALYSIS_CREATED: "badge--info",
  STRATEGY_VERSION_PROPOSED: "badge--warning",
};

export function EventTypeBadge({ eventType }: { eventType: JournalEventType }) {
  return <span className={`badge ${EVENT_TYPE_CLASS[eventType]}`}>{eventType}</span>;
}

export const EVENT_TYPE_LABELS: Record<JournalEventType, string> = {
  SETUP_CREATED: "Setup Created",
  STRATEGY_EVALUATED: "Strategy Evaluated",
  RISK_CALCULATED: "Risk Calculated",
  SETUP_APPROVED: "Decision: Approved",
  SETUP_REJECTED: "Decision: Rejected",
  SETUP_INVALIDATED: "Decision: Invalidated",
  SETUP_EXPIRED: "Decision: Expired",
  TRADE_READY: "Trade Ready",
  TRADE_EXECUTED: "Trade Executed",
  TRADE_SKIPPED: "Trade Skipped",
  TRADE_CLOSED: "Trade Closed",
  POST_TRADE_ANALYSIS_CREATED: "Post-Trade Analysis",
  STRATEGY_VERSION_PROPOSED: "Strategy Version Proposed",
};
