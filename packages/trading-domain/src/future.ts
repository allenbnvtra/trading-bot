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
 * AgentExecution (plus the new ResearchHypothesis/ResearchExperiment) was
 * promoted out of this file in Milestone 7 — it is now a real, persisted
 * entity in packages/trading-domain/src/research-entities.ts, scoped to the
 * RESEARCH agent type only (see AgentType there). This placeholder's
 * broader setup/trade-linked runtime-agent shape remains unimplemented and
 * is deliberately not reintroduced here; a future runtime agent gets its
 * own real entity when that milestone lands, the same way this one did.
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
