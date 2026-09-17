import type { Direction, RecommendationState, Timeframe } from "@trading-copilot/shared-types";

/**
 * FUTURE DOMAIN TYPES — Milestone 2+
 *
 * These interfaces exist so later milestones (the trade journal, runtime
 * agents, TradingView ingestion, live setup lifecycle) have a stable shape
 * to build against. They intentionally do NOT have corresponding database
 * tables yet — see docs/trade-journal-design.md for the schema design and
 * docs/roadmap.md for when each one gets implemented.
 *
 * Do not import these from Milestone 1 code paths (strategy-engine,
 * backtester, risk-engine, or the API/dashboard) — they are placeholders.
 */

/** Immutable snapshot of "what the market looked like" at decision time. */
export interface MarketSnapshot {
  id: string;
  timestamp: Date;
  instrumentId: string;
  timeframe: Timeframe;
  trend1m?: string;
  trend5m?: string;
  trend15m?: string;
  trend1h?: string;
  trend4h?: string;
  trend1d?: string;
  atr: string;
  atrPercentile?: number;
  volume: string;
  volumePercentile?: number;
  vwap?: string;
  vwapDistance?: string;
  nearestSupport?: string;
  distanceToSupport?: string;
  nearestResistance?: string;
  distanceToResistance?: string;
  openingRange?: { high: string; low: string };
  previousDayHigh?: string;
  previousDayLow?: string;
  session?: string;
  timeOfDay?: string;
  dayOfWeek?: string;
  marketRegime?: string;
  economicEventProximityMinutes?: number;
}

/** A candidate trade produced by strategy evaluation, prior to human review. */
export interface Setup {
  id: string;
  instrumentId: string;
  strategyVersionId: string;
  marketSnapshotId: string;
  direction: Direction;
  status: RecommendationState;
  createdAt: Date;
  expiresAt: Date | null;
}

/** A discrete future strategy insight, not yet validated. */
export interface Signal {
  id: string;
  setupId: string;
  strategyVersionId: string;
  timestamp: Date;
  description: string;
}

/** Audit record of a single future runtime AI agent invocation. Never stores hidden chain-of-thought. */
export interface AgentExecution {
  id: string;
  setupId: string;
  tradeId?: string;
  agentType: string;
  agentVersion: string;
  provider: string;
  model: string;
  promptTemplateVersion: string;
  startedAt: Date;
  completedAt: Date | null;
  latencyMs: number | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  structuredInput: Record<string, unknown>;
  structuredOutput: Record<string, unknown> | null;
  decision?: string;
  confidence?: number;
  reasoningSummary?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Deterministic risk output for a setup — never produced by an LLM. */
export interface RiskCalculation {
  id: string;
  setupId: string;
  accountEquity: string;
  riskPercentage: string;
  entry: string;
  stop: string;
  stopDistancePoints: string;
  stopDistanceTicks: string;
  riskBudget: string;
  riskPerContract: string;
  quantity: number;
  riskReward: string;
  estimatedMargin: string | "UNKNOWN";
}

/** A trade ticket handed to the human for manual execution. Never auto-executed. */
export interface TradeTicket {
  id: string;
  setupId: string;
  riskCalculationId: string;
  instrumentId: string;
  direction: Direction;
  entry: string;
  stop: string;
  targets: string[];
  quantity: number;
  expiresAt: Date | null;
}

/** What the human actually did, recorded after the fact. */
export interface ManualTrade {
  id: string;
  setupId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  instrumentId: string;
  direction: Direction;
  plannedEntry: string;
  plannedStop: string;
  plannedTargets: string[];
  actualEntry?: string;
  actualExit?: string;
  entryTimestamp?: Date;
  exitTimestamp?: Date;
  plannedRisk: string;
  quantity: number;
  tickValue: string;
  pointValue: string;
  estimatedFees: string;
  actualFees?: string;
  estimatedSlippage: string;
  actualSlippage?: string;
  grossPnl?: string;
  netPnl?: string;
  rMultiple?: string;
  maximumFavorableExcursion?: string;
  maximumAdverseExcursion?: string;
  executionMode: "PAPER" | "MANUAL_LIVE" | "SKIPPED";
  entryNotes?: string;
  exitNotes?: string;
}

/** Structured, causal-conclusion-avoiding analysis of a closed trade. */
export interface PostTradeAnalysis {
  id: string;
  tradeId: string;
  primaryCause?: string;
  contributingFactors: string[];
  confidence?: number;
  evidence: Record<string, unknown>;
  researchHypotheses: string[];
}

/** Append-only audit event. See docs/trade-journal-design.md for the full event taxonomy. */
export interface JournalEvent {
  id: string;
  eventType: string;
  timestamp: Date;
  entityType: string;
  entityId: string;
  correlationId?: string;
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  metadata: Record<string, unknown>;
}
