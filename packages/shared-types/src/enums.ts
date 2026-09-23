/**
 * Enumerations shared across the entire monorepo.
 *
 * These are the vocabulary of the domain. Keep them here, not duplicated in
 * apps/api DTOs, apps/dashboard types, or Prisma schema comments.
 */

export const ASSET_CLASSES = ["FUTURES", "FOREX", "CRYPTO", "STOCK"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const DIRECTIONS = ["LONG", "SHORT"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * Backtest job lifecycle. Mirrors the async job states used by BullMQ so the
 * dashboard can render QUEUED/RUNNING/COMPLETED/FAILED without guessing.
 */
export const BACKTEST_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED"] as const;
export type BacktestStatus = (typeof BACKTEST_STATUSES)[number];

/**
 * Future full strategy lifecycle (see docs/roadmap.md and CLAUDE.md).
 * Milestone 1 only ever creates versions in BACKTESTING status; the rest of
 * the lifecycle is enforced once the research/validation pipeline exists.
 */
export const STRATEGY_VERSION_STATUSES = [
  "DISCOVERED",
  "BACKTESTING",
  "VALIDATION",
  "OUT_OF_SAMPLE",
  "WALK_FORWARD",
  "PAPER_TRADING",
  "APPROVED",
  "PAUSED",
  "RETIRED",
] as const;
export type StrategyVersionStatus = (typeof STRATEGY_VERSION_STATUSES)[number];

/**
 * Why a BacktestTrade closed. SAME_CANDLE_STOP_AND_TARGET is used when a
 * single candle's range touched both the stop and the target — see
 * docs/backtesting-assumptions.md for the conservative rule applied.
 */
export const TRADE_EXIT_REASONS = [
  "STOP",
  "TARGET",
  "SAME_CANDLE_STOP_AND_TARGET",
  "END_OF_DATA",
] as const;
export type TradeExitReason = (typeof TRADE_EXIT_REASONS)[number];

/**
 * Future human-facing recommendation states (see <critical_principles> in
 * the product spec). Never an order — always a recommendation the human
 * acts on manually.
 */
export const RECOMMENDATION_STATES = [
  "READY",
  "WAIT",
  "REJECTED",
  "INVALIDATED",
  "EXPIRED",
] as const;
export type RecommendationState = (typeof RECOMMENDATION_STATES)[number];

/**
 * Milestone 2: the Setup lifecycle state machine (see docs/trade-journal-design.md).
 * Forward path is WATCH -> PREPARE -> READY. REJECTED, INVALIDATED, and
 * EXPIRED are terminal and reachable from any non-terminal state. Once a
 * Setup reaches a terminal state it cannot be moved to a different state —
 * enforced in apps/api's setup service, not just in the type system.
 */
export const SETUP_STATUSES = [
  "WATCH",
  "PREPARE",
  "READY",
  "REJECTED",
  "INVALIDATED",
  "EXPIRED",
] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

export const TERMINAL_SETUP_STATUSES: readonly SetupStatus[] = [
  "REJECTED",
  "INVALIDATED",
  "EXPIRED",
];

/**
 * Where a Setup came from: a strategy evaluation correlated to an existing
 * deterministic BacktestTrade (BACKTEST), a human exercising the journal
 * manually (MANUAL_TEST), an internal process such as the seed/demo
 * pipeline (SYSTEM), or a live TradingView alert (TRADINGVIEW — Milestone 3).
 */
export const SETUP_SOURCES = ["BACKTEST", "MANUAL_TEST", "SYSTEM", "TRADINGVIEW"] as const;
export type SetupSource = (typeof SETUP_SOURCES)[number];

/**
 * How a JournalTrade was (or would have been) executed. BACKTEST exists here
 * for the normalized analytics view (see packages/analytics) that treats a
 * deterministic BacktestTrade and a real JournalTrade uniformly for grouping
 * purposes — it does not imply BacktestTrade rows are duplicated into
 * JournalTrade. SKIPPED means a setup reached READY but the human chose not
 * to take it; it is recorded so filtering quality can be measured later.
 */
export const EXECUTION_MODES = ["BACKTEST", "PAPER", "MANUAL_LIVE", "SKIPPED"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Lifecycle of a single JournalTrade row, independent of ExecutionMode. */
export const JOURNAL_TRADE_STATUSES = ["PLANNED", "OPEN", "CLOSED", "SKIPPED"] as const;
export type JournalTradeStatus = (typeof JOURNAL_TRADE_STATUSES)[number];

/** Which table a polymorphic reference (PostTradeAnalysis, TradeScreenshot) points to. */
export const TRADE_SOURCES = ["BACKTEST_TRADE", "JOURNAL_TRADE"] as const;
export type TradeSource = (typeof TRADE_SOURCES)[number];

export const POST_TRADE_OUTCOMES = ["WIN", "LOSS", "BREAKEVEN"] as const;
export type PostTradeOutcome = (typeof POST_TRADE_OUTCOMES)[number];

/**
 * Structured loss (and, generically, contributing-factor) categories for
 * PostTradeAnalysis. Per CLAUDE.md and docs/research-methodology.md, nothing
 * in this codebase auto-classifies a trade into one of these — a row is only
 * ever created by a genuine analysis mechanism, which does not exist yet.
 * UNKNOWN is for when a genuine analysis was attempted but couldn't
 * determine a cause — it is never a default filler.
 */
export const LOSS_CATEGORIES = [
  "TREND_MISALIGNMENT",
  "RESISTANCE_TOO_CLOSE",
  "SUPPORT_TOO_CLOSE",
  "HIGH_VOLATILITY",
  "LOW_VOLATILITY",
  "LOW_VOLUME",
  "BREAKOUT_FAILURE",
  "FALSE_BREAKOUT",
  "EARLY_ENTRY",
  "LATE_ENTRY",
  "NEWS_EVENT",
  "BAD_RISK_REWARD",
  "MARKET_REGIME_MISMATCH",
  "SESSION_TIMING",
  "GAP_EVENT",
  "STOP_TOO_TIGHT",
  "STOP_TOO_WIDE",
  "UNKNOWN",
] as const;
export type LossCategory = (typeof LOSS_CATEGORIES)[number];

/**
 * Append-only journal event taxonomy (see docs/trade-journal-design.md).
 * This is the Milestone 2+3 subset only — AGENT_STARTED/COMPLETED/FAILED,
 * RESEARCH_HYPOTHESIS_CREATED, etc. are added in later milestones via a
 * migration when the runtime agents that emit them actually exist. Adding a
 * new value later is a small additive migration; do not pre-add speculative
 * values now.
 *
 * The WEBHOOK_ values (Milestone 3) audit the TradingView ingestion
 * pipeline itself, correlated on the InboundWebhookEvent's own id — see
 * docs/trade-journal-design.md "TradingView webhook ingestion". They are
 * distinct from the SETUP- and TRADE-prefixed events above, which stay
 * correlated on a Setup's id once one exists.
 */
export const JOURNAL_EVENT_TYPES = [
  "SETUP_CREATED",
  "STRATEGY_EVALUATED",
  "RISK_CALCULATED",
  "SETUP_APPROVED",
  "SETUP_REJECTED",
  "SETUP_INVALIDATED",
  "SETUP_EXPIRED",
  "TRADE_READY",
  "TRADE_EXECUTED",
  "TRADE_SKIPPED",
  "TRADE_CLOSED",
  "POST_TRADE_ANALYSIS_CREATED",
  "STRATEGY_VERSION_PROPOSED",
  "WEBHOOK_RECEIVED",
  "WEBHOOK_NORMALIZED",
  "SIGNAL_ACCEPTED",
  "WEBHOOK_DUPLICATE_DETECTED",
  "WEBHOOK_REJECTED",
  "WEBHOOK_PROCESSING_FAILED",
  // Milestone 5 — screenshot generation lifecycle. See docs/screenshot-design.md.
  "SCREENSHOT_REQUESTED",
  "SCREENSHOT_GENERATION_STARTED",
  "SCREENSHOT_CREATED",
  "SCREENSHOT_FAILED",
  "SCREENSHOT_RETRIED",
  // Milestone 6 — notification delivery lifecycle. See docs/notifications.md.
  "NOTIFICATION_QUEUED",
  "NOTIFICATION_SENDING",
  "NOTIFICATION_SENT",
  "NOTIFICATION_RETRYING",
  "NOTIFICATION_FAILED",
] as const;
export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

/** What kind of entity a JournalEvent's entityId points to (polymorphic reference, no DB-level FK). */
export const JOURNAL_ENTITY_TYPES = [
  "SETUP",
  "JOURNAL_TRADE",
  "RISK_CALCULATION",
  "MARKET_SNAPSHOT",
  "BACKTEST",
  "BACKTEST_TRADE",
  "STRATEGY_VERSION",
  "POST_TRADE_ANALYSIS",
  "INBOUND_WEBHOOK_EVENT",
  "TRADE_SCREENSHOT",
  "NOTIFICATION_DELIVERY",
] as const;
export type JournalEntityType = (typeof JOURNAL_ENTITY_TYPES)[number];

/** Screenshot capture point (see docs/screenshot-design.md). Schema foundation only in Milestone 2. */
export const SCREENSHOT_TYPES = ["PRE_TRADE", "POST_TRADE"] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];

/**
 * Milestone 5: a TradeScreenshot's generation lifecycle (see
 * docs/screenshot-design.md). REQUESTED -> GENERATING -> READY|FAILED. A
 * READY row is immutable historical evidence — a behavior change (e.g. a
 * chart-rendering config change) bumps chartConfigVersion and creates a new
 * row rather than mutating an existing one.
 */
export const SCREENSHOT_STATUSES = ["REQUESTED", "GENERATING", "READY", "FAILED"] as const;
export type ScreenshotStatus = (typeof SCREENSHOT_STATUSES)[number];

/**
 * Milestone 3: TradingView webhook ingestion. Provider is its own enum
 * (rather than a hardcoded literal) so a future non-TradingView signal
 * source can be added additively — see packages/shared-types/src/webhooks.ts
 * and docs/tradingview-setup.md.
 */
export const WEBHOOK_PROVIDERS = ["TRADINGVIEW"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/**
 * InboundWebhookEvent lifecycle. RECEIVED -> QUEUED happens synchronously in
 * the HTTP handler (see docs/tradingview-setup.md); PROCESSING -> one of
 * PROCESSED/REJECTED/FAILED/UNSUPPORTED happens in the BullMQ worker.
 *
 * DUPLICATE is reserved, not currently set by any code path. A repeat
 * delivery never gets its own row (the fingerprint's database unique
 * constraint prevents that) and never mutates the *original* row's status
 * either: overwriting an already-PROCESSED original back to DUPLICATE would
 * incorrectly imply that a genuinely successful delivery was invalidated.
 * "This event was redelivered" is instead conveyed two other ways: the
 * `wasDuplicate: true` flag on createInboundWebhookEvent's return value (for
 * the immediate HTTP caller), and a WEBHOOK_DUPLICATE_DETECTED journal event
 * correlated to the original row (for the durable audit trail) - see
 * packages/database/src/repositories/inbound-webhook-events.ts. Filtering
 * `GET /webhooks/tradingview/events?processingStatus=DUPLICATE` will always
 * return zero rows today.
 */
export const WEBHOOK_PROCESSING_STATUSES = [
  "RECEIVED",
  "QUEUED",
  "PROCESSING",
  "PROCESSED",
  "DUPLICATE",
  "REJECTED",
  "FAILED",
  "UNSUPPORTED",
] as const;
export type WebhookProcessingStatus = (typeof WEBHOOK_PROCESSING_STATUSES)[number];

/**
 * Structured failure codes for a REJECTED/UNSUPPORTED InboundWebhookEvent.
 * Stored as a plain string column (not a DB enum) so a genuinely
 * unanticipated failure can still record a useful free-form message without
 * a migration — these are the known, expected codes the normalizer/resolver
 * pipeline itself produces.
 */
export const WEBHOOK_FAILURE_CODES = [
  "UNSUPPORTED_SCHEMA_VERSION",
  "MALFORMED_PAYLOAD",
  "UNSUPPORTED_SIGNAL_TYPE",
  "UNSUPPORTED_TIMEFRAME",
  "UNKNOWN_INSTRUMENT",
  "UNKNOWN_STRATEGY_VERSION",
  "INTERNAL_ERROR",
] as const;
export type WebhookFailureCode = (typeof WEBHOOK_FAILURE_CODES)[number];

/**
 * Signal types a TradingView payload's `signal` field may carry. Only
 * SETUP_CANDIDATE is supported in Milestone 3; anything else is rejected
 * with UNSUPPORTED_SIGNAL_TYPE rather than guessed at.
 */
export const TRADINGVIEW_SIGNAL_TYPES = ["SETUP_CANDIDATE"] as const;
export type TradingViewSignalType = (typeof TRADINGVIEW_SIGNAL_TYPES)[number];
