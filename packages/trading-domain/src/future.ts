import type { Direction } from "@trading-copilot/shared-types";

/**
 * FUTURE DOMAIN TYPES — Milestone 3+
 *
 * These interfaces exist so later milestones (TradingView ingestion, runtime
 * agents) have a stable shape to build against. They intentionally do NOT
 * have corresponding database tables yet — see docs/trade-journal-design.md
 * for the schema design and docs/roadmap.md for when each one gets
 * implemented.
 *
 * MarketSnapshot, Setup, RiskCalculation, JournalTrade, JournalEvent,
 * PostTradeAnalysis, and TradeScreenshot were promoted out of this file in
 * Milestone 2 — they are now real, persisted entities in
 * packages/trading-domain/src/journal-entities.ts.
 *
 * Do not import the remaining placeholders below from real code paths
 * (strategy-engine, backtester, risk-engine, database, or the API/dashboard)
 * until the milestone that implements them lands.
 */

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
