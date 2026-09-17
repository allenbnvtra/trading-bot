# Trade Journal Design (Future — Milestone 2+)

The journal is a core product capability, not an afterthought. Its purpose: make every decision the system ever makes — approved, rejected, invalidated, expired, skipped, executed — measurable after the fact from stored data, never from AI memory. Milestone 1 does not implement these tables; this document exists so Milestone 2 has a stable design to build against and so schema decisions made now (in `packages/database`) don't foreclose it.

## Decision-time integrity

Pre-trade information must never be contaminated by post-trade information:

**Pre-trade** (immutable once recorded): market snapshot, strategy output, agent outputs, risk calculation, system decision.

**Post-trade** (recorded later, separately): actual execution, actual exit, P&L, MFE, MAE, winner/loss analysis.

These live in different record types so a query for "what did we know when we decided" can never accidentally pull in information from after the fact.

## Market snapshots

An immutable `MarketSnapshot` captures what the market looked like at a moment in time: recent OHLCV context, multi-timeframe trend (1m/5m/15m/1h/4h/1d), ATR and its percentile, volume and its percentile, VWAP and distance to it, nearest support/resistance and distance, opening range, previous-day high/low, session, time of day, day of week, market regime, and proximity to known economic events. See `packages/trading-domain/src/future.ts` for the draft interface.

## Journal events (append-only)

An append-only event log, not a replacement for relational business tables. Event types: `SETUP_CREATED`, `STRATEGY_EVALUATED`, `AGENT_STARTED`/`AGENT_COMPLETED`/`AGENT_FAILED`, `RISK_CALCULATED`, `SETUP_APPROVED`/`SETUP_REJECTED`/`SETUP_INVALIDATED`/`SETUP_EXPIRED`, `TRADE_READY`, `TRADE_EXECUTED`/`TRADE_SKIPPED`, `TRADE_UPDATED`/`TRADE_CLOSED`, `POST_TRADE_ANALYSIS_STARTED`/`POST_TRADE_ANALYSIS_COMPLETED`, `RESEARCH_HYPOTHESIS_CREATED`, `STRATEGY_VERSION_PROPOSED`/`STRATEGY_VERSION_APPROVED`/`STRATEGY_PAUSED`. Fields: `id`, `eventType`, `timestamp`, `entityType`, `entityId`, `correlationId`, `instrumentId`, `strategyId`, `strategyVersionId`, `metadata` (JSON).

## Agent execution audit

Every future runtime AI agent call is recorded: `id`, `setupId`, `tradeId`, `agentType`, `agentVersion`, `provider`, `model`, `promptTemplateVersion`, `startedAt`/`completedAt`/`latencyMs`, `status`, `structuredInput`/`structuredOutput` (JSON), `decision`, `confidence`, `reasoningSummary`, `inputTokens`/`outputTokens`/`estimatedCost`, `errorCode`/`errorMessage`. Hidden chain-of-thought is never stored — only structured output and a concise audit summary.

## Manual trades

What the human actually did, recorded after the fact: planned entry/stop/targets vs. actual entry/exit, timestamps, planned risk, quantity, tick/point value, estimated vs. actual fees and slippage, gross/net P&L, R multiple, MFE/MAE, `executionMode` (`PAPER` / `MANUAL_LIVE` / `SKIPPED`), entry/exit notes. No automated broker execution ever writes this table — it is a record of a human action.

## Rejected and skipped setups

Rejected and skipped setups are as important as executed trades — without them, filtering quality (did the Critic Agent's rejections actually avoid bad trades?) cannot be measured. Optional hypothetical-outcome tracking (what would have happened if executed) is always clearly labeled simulated and never mixed into real P&L reporting.

## Winner and loser analysis

Never conclude "X causes losses" purely because X is common among losing trades. Always compute, for any candidate condition: sample size, prevalence among winners, prevalence among losers, average R with/without the condition, and profit factor with/without the condition — reported across **losers, winners, and all trades** together.

## Agent value measurement

Agents are evaluated on observed historical outcomes, never on how convincing their explanation sounds: performance when an agent approves vs. rejects, hypothetical performance of agent-rejected setups, performance when multiple agents agree vs. disagree.

## Screenshots

Metadata only in PostgreSQL (`id`, `tradeId`/`setupId`, `type` [`PRE_TRADE`/`POST_TRADE`], `createdAt`, `marketSnapshotId`, `storageKey`, `mimeType`, `width`/`height`, `chartConfigVersion`) — the image itself lives in object storage (local disk in development, S3-compatible in production), never as a large blob in the database. The `PRE_TRADE` image is never overwritten after the trade closes. See `docs/screenshot-design.md`.

## Analytics filtering surface

Future performance analytics must support filtering by strategy, strategy version, instrument, timeframe, direction, session, hour, day of week, market regime, volatility regime, setup type, entry/stop/target method, agent decisions, rejection reasons, and paper vs. manual-live — and must never silently aggregate across different strategy versions.

## Why no journal tables exist in Milestone 1

Milestone 1 has no setups, no agents, and no live decision flow yet — there is nothing to journal. Building these tables now would mean empty, unused tables and a schema shaped around guesses instead of the real Milestone 2 requirements. `packages/trading-domain/src/future.ts` holds the draft TypeScript interfaces so the shape is already agreed on when Milestone 2 begins.
