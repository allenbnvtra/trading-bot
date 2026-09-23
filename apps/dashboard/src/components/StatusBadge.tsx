import type {
  BacktestStatus,
  Direction,
  ExecutionMode,
  JournalEventType,
  JournalTradeStatus,
  NormalizedTradeSource,
  NotificationDeliveryStatus,
  PostTradeOutcome,
  ScreenshotStatus,
  SetupSource,
  SetupStatus,
  WebhookProcessingStatus,
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

const SETUP_SOURCE_CLASS: Record<SetupSource, string> = {
  BACKTEST: "badge--neutral",
  MANUAL_TEST: "badge--neutral",
  SYSTEM: "badge--neutral",
  TRADINGVIEW: "badge--info",
};

export function SetupSourceBadge({ source }: { source: SetupSource }) {
  return <span className={`badge ${SETUP_SOURCE_CLASS[source]}`}>{source}</span>;
}

const WEBHOOK_PROCESSING_STATUS_CLASS: Record<WebhookProcessingStatus, string> = {
  RECEIVED: "badge--neutral",
  QUEUED: "badge--queued",
  PROCESSING: "badge--running",
  PROCESSED: "badge--success",
  DUPLICATE: "badge--warning",
  REJECTED: "badge--danger",
  FAILED: "badge--danger",
  UNSUPPORTED: "badge--warning",
};

export function WebhookProcessingStatusBadge({ status }: { status: WebhookProcessingStatus }) {
  return <span className={`badge ${WEBHOOK_PROCESSING_STATUS_CLASS[status]}`}>{status}</span>;
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

const OUTCOME_CLASS: Record<PostTradeOutcome, string> = {
  WIN: "badge--success",
  LOSS: "badge--danger",
  BREAKEVEN: "badge--neutral",
};

/** Null (not yet CLOSED) is a caller concern - render nothing/"N/A" at the call site, never a fabricated outcome here. */
export function OutcomeBadge({ outcome }: { outcome: PostTradeOutcome }) {
  return <span className={`badge ${OUTCOME_CLASS[outcome]}`}>{outcome}</span>;
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
  WEBHOOK_RECEIVED: "badge--neutral",
  WEBHOOK_NORMALIZED: "badge--info",
  SIGNAL_ACCEPTED: "badge--success",
  WEBHOOK_DUPLICATE_DETECTED: "badge--warning",
  WEBHOOK_REJECTED: "badge--danger",
  WEBHOOK_PROCESSING_FAILED: "badge--danger",
};

export function EventTypeBadge({ eventType }: { eventType: JournalEventType }) {
  return <span className={`badge ${EVENT_TYPE_CLASS[eventType]}`}>{eventType}</span>;
}

const SCREENSHOT_STATUS_CLASS: Record<ScreenshotStatus, string> = {
  REQUESTED: "badge--queued",
  GENERATING: "badge--running",
  READY: "badge--success",
  FAILED: "badge--danger",
};

export function ScreenshotStatusBadge({ status }: { status: ScreenshotStatus }) {
  return <span className={`badge ${SCREENSHOT_STATUS_CLASS[status]}`}>{status}</span>;
}

const NOTIFICATION_DELIVERY_STATUS_CLASS: Record<NotificationDeliveryStatus, string> = {
  QUEUED: "badge--queued",
  SENDING: "badge--running",
  SENT: "badge--success",
  FAILED: "badge--danger",
  RETRYING: "badge--warning",
};

export function NotificationDeliveryStatusBadge({ status }: { status: NotificationDeliveryStatus }) {
  return <span className={`badge ${NOTIFICATION_DELIVERY_STATUS_CLASS[status]}`}>{status}</span>;
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
  WEBHOOK_RECEIVED: "Webhook Received",
  WEBHOOK_NORMALIZED: "Webhook Normalized",
  SIGNAL_ACCEPTED: "Signal Accepted",
  WEBHOOK_DUPLICATE_DETECTED: "Webhook Duplicate Detected",
  WEBHOOK_REJECTED: "Webhook Rejected",
  WEBHOOK_PROCESSING_FAILED: "Webhook Processing Failed",
};
