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
 * Where a Setup came from. TradingView-originated setups arrive in a later
 * milestone; for now every setup is either produced by correlating an
 * existing deterministic BacktestTrade (BACKTEST), created by a human
 * exercising the journal manually (MANUAL_TEST), or created by an internal
 * process such as the seed/demo pipeline (SYSTEM).
 */
export const SETUP_SOURCES = ["BACKTEST", "MANUAL_TEST", "SYSTEM"] as const;
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
 * This is the Milestone 2 subset only — AGENT_STARTED/COMPLETED/FAILED,
 * RESEARCH_HYPOTHESIS_CREATED, etc. are added in later milestones via a
 * migration when the runtime agents that emit them actually exist. Adding a
 * new value later is a small additive migration; do not pre-add speculative
 * values now.
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
] as const;
export type JournalEntityType = (typeof JOURNAL_ENTITY_TYPES)[number];

/** Screenshot capture point (see docs/screenshot-design.md). Schema foundation only in Milestone 2. */
export const SCREENSHOT_TYPES = ["PRE_TRADE", "POST_TRADE"] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];
