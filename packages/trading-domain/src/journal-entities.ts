import type Decimal from "decimal.js";
import type {
  Direction,
  ExecutionMode,
  JournalEntityType,
  JournalEventType,
  JournalTradeStatus,
  LossCategory,
  PostTradeOutcome,
  ScreenshotType,
  SetupSource,
  SetupStatus,
  Timeframe,
  TradeSource,
} from "@trading-copilot/shared-types";

/**
 * Milestone 2 journal/analytics entities. These are real, persisted tables
 * (see packages/database/prisma/schema.prisma) — unlike
 * packages/trading-domain/src/future.ts, which holds types for milestones
 * that have no schema yet.
 *
 * As with Milestone 1's entities.ts: money/price/ratio fields use Decimal,
 * never number or string, and these interfaces are decoupled from Prisma's
 * generated types (mapping happens in packages/database/src/mappers.ts).
 */

/**
 * Immutable snapshot of "what the market looked like" at decision time.
 * Never updated after creation — packages/database exposes no update
 * function for this model. A Setup that needs fresher context creates a new
 * MarketSnapshot row and points at it; it never mutates an old one.
 */
export interface MarketSnapshot {
  id: string;
  instrumentId: string;
  timestamp: Date;
  timeframe: Timeframe;
  windowCandleCount: number | null;
  windowStartTimestamp: Date | null;
  windowEndTimestamp: Date | null;
  trend1m: string | null;
  trend5m: string | null;
  trend15m: string | null;
  trend1h: string | null;
  trend4h: string | null;
  trend1d: string | null;
  atr: Decimal | null;
  /** Fraction 0-1, matching the convention used by BacktestMetrics.winRate — never a 0-100 percentage. */
  atrPercentile: Decimal | null;
  volume: Decimal | null;
  volumePercentile: Decimal | null;
  vwap: Decimal | null;
  vwapDistance: Decimal | null;
  nearestSupport: Decimal | null;
  distanceToSupport: Decimal | null;
  nearestResistance: Decimal | null;
  distanceToResistance: Decimal | null;
  session: string | null;
  timeOfDay: string | null;
  dayOfWeek: string | null;
  /** Free-form for now — RegimeAgent's formal taxonomy (Milestone 7) isn't built yet. */
  marketRegime: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * A candidate trade, pending human (or, in a later milestone, agent) review.
 * The state machine (see SETUP_STATUSES / TERMINAL_SETUP_STATUSES in
 * shared-types) is enforced by apps/api's setup service, not by the schema.
 *
 * plannedStop/plannedTarget1 are nullable (Milestone 3): a MANUAL_TEST or
 * BACKTEST-sourced setup normally supplies a fully-planned trade up front,
 * but a TRADINGVIEW-sourced setup often begins with only a candidate entry
 * (the alert bar's close) — the stop/target genuinely aren't known yet, and
 * "unknown information must remain unknown" rather than fabricated (see
 * docs/tradingview-setup.md). plannedEntry stays required — it is always a
 * real observed price at the moment the setup is created, from any source.
 */
export interface Setup {
  id: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  marketSnapshotId: string;
  direction: Direction;
  source: SetupSource;
  plannedEntry: Decimal;
  plannedStop: Decimal | null;
  plannedTarget1: Decimal | null;
  plannedTarget2: Decimal | null;
  status: SetupStatus;
  decisionSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  /** Milestone 3: set only for a TRADINGVIEW-sourced Setup, to the InboundWebhookEvent that produced it. Unique in the database, so a retried webhook-processing job can never create a second Setup for the same delivery. */
  sourceWebhookEventId: string | null;
}

/**
 * A deterministic risk calculation, always produced by packages/risk-engine
 * and never independently computed in a controller or the dashboard.
 * Immutable once created: a Setup that needs a fresh calculation (e.g. price
 * moved) gets a new RiskCalculation row, not an update to an old one.
 */
export interface RiskCalculation {
  id: string;
  setupId: string;
  accountEquity: Decimal;
  riskPercentage: Decimal;
  riskBudget: Decimal;
  entryPrice: Decimal;
  stopPrice: Decimal;
  stopDistancePoints: Decimal;
  stopDistanceTicks: Decimal;
  pointValue: Decimal;
  tickValue: Decimal;
  estimatedCommission: Decimal;
  estimatedSlippage: Decimal;
  riskPerUnit: Decimal;
  calculatedQuantity: number;
  estimatedTotalRisk: Decimal;
  riskReward: Decimal;
  createdAt: Date;
}

/**
 * A real (paper or manual-live) trade, or a record that a READY setup was
 * deliberately skipped. Distinct from Milestone 1's BacktestTrade by design
 * — see docs/trade-journal-design.md "Backtest -> journal compatibility."
 * BacktestTrade rows are never copied into this table; packages/analytics
 * normalizes both into a common shape for cross-cutting analytics instead.
 */
export interface JournalTrade {
  id: string;
  setupId: string | null;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  plannedEntry: Decimal;
  plannedStop: Decimal;
  plannedTarget1: Decimal | null;
  plannedTarget2: Decimal | null;
  actualEntry: Decimal | null;
  actualExit: Decimal | null;
  entryTimestamp: Date | null;
  exitTimestamp: Date | null;
  quantity: number | null;
  plannedRisk: Decimal | null;
  estimatedFees: Decimal | null;
  actualFees: Decimal | null;
  estimatedSlippage: Decimal | null;
  actualSlippage: Decimal | null;
  grossPnl: Decimal | null;
  netPnl: Decimal | null;
  rMultiple: Decimal | null;
  mfe: Decimal | null;
  mae: Decimal | null;
  executionMode: ExecutionMode;
  status: JournalTradeStatus;
  entryNotes: string | null;
  exitNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Append-only audit event. Never updated or deleted — packages/database
 * exposes only a create function for this model. entityType/entityId is a
 * polymorphic reference (no DB-level foreign key, since it points at
 * different tables depending on entityType) used to reconstruct a
 * chronological decision timeline for any entity.
 */
export interface JournalEvent {
  id: string;
  eventType: JournalEventType;
  timestamp: Date;
  entityType: JournalEntityType;
  entityId: string;
  correlationId: string | null;
  instrumentId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Structured, causal-conclusion-avoiding analysis of a closed trade.
 * tradeSource+tradeId is a polymorphic reference to either a BacktestTrade
 * or a JournalTrade (same reasoning as JournalEvent). Nothing in this
 * codebase auto-populates this table — see CLAUDE.md and
 * docs/research-methodology.md: a row here means a genuine analysis
 * mechanism produced it, not that one was inferred to fill the field.
 */
export interface PostTradeAnalysis {
  id: string;
  tradeId: string;
  tradeSource: TradeSource;
  outcome: PostTradeOutcome;
  primaryCause: LossCategory | null;
  contributingFactors: LossCategory[];
  confidence: Decimal | null;
  evidence: Record<string, unknown>;
  researchHypotheses: string[];
  createdAt: Date;
}

/**
 * A trade, from either packages/analytics' point of view, in a shape common
 * to both a Milestone 1 BacktestTrade and a Milestone 2 JournalTrade. This
 * exists so cross-cutting analytics (grouping, winner/loser comparison) can
 * treat both sources uniformly without either physically duplicating the
 * other — see docs/trade-journal-design.md "Backtest -> journal
 * compatibility." packages/database produces this shape (mapping both
 * source tables); packages/analytics only ever consumes it, never queries a
 * database directly.
 *
 * Only ever built from a *closed* trade: a BacktestTrade (always closed by
 * construction) or a JournalTrade with status CLOSED. Planned/open/skipped
 * JournalTrade rows have no realized P&L and are never normalized.
 */
export interface NormalizedTrade {
  source: "BACKTEST" | "JOURNAL";
  id: string;
  strategyId: string;
  strategyVersionId: string;
  instrumentId: string;
  direction: Direction;
  executionMode: ExecutionMode;
  entryTimestamp: Date;
  exitTimestamp: Date;
  entryPrice: Decimal;
  exitPrice: Decimal;
  quantity: number;
  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  /** null only for a JOURNAL-sourced trade whose JournalTrade.plannedRisk was never set. */
  riskAmount: Decimal | null;
  /** null whenever riskAmount is null (rMultiple is undefined without a risk baseline). */
  rMultiple: Decimal | null;
  mfe: Decimal | null;
  mae: Decimal | null;
  /**
   * null for a BACKTEST-sourced trade — packages/backtester applies slippage
   * directly to fill prices rather than tracking it as a separate figure, so
   * there is nothing meaningful to report here for that source. For a
   * JOURNAL-sourced trade this is JournalTrade.actualSlippage, falling back
   * to estimatedSlippage if the actual figure was never recorded.
   */
  slippage: Decimal | null;
}

/**
 * Screenshot metadata only — the image itself lives in object storage (see
 * docs/screenshot-design.md), never as a blob in Postgres. Schema
 * foundation only in Milestone 2; no renderer/capture pipeline exists yet.
 */
export interface TradeScreenshot {
  id: string;
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  type: ScreenshotType;
  storageKey: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  marketSnapshotId: string | null;
  chartConfigVersion: string | null;
  createdAt: Date;
}
