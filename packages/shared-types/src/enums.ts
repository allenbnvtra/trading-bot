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
