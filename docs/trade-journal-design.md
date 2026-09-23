# Trade Journal Design

The journal is a core product capability, not an afterthought. Its purpose: make every decision the system ever makes — approved, rejected, invalidated, expired, skipped, executed — measurable after the fact from stored data, never from AI memory.

Milestone 1 shipped the deterministic backtester (`Instrument`, `Candle`, `Strategy`, `StrategyVersion`, `Backtest`, `BacktestTrade`, `BacktestMetrics`). Milestone 2 added the journal/analytics foundation on top of it: `MarketSnapshot`, `Setup`, `RiskCalculation`, `JournalTrade`, `JournalEvent`, `PostTradeAnalysis`, and `TradeScreenshot` (schema only at the time). **Milestone 3 connects a real, external signal source, TradingView webhook alerts, into that same `Setup`/`JournalEvent` architecture**: `InboundWebhookEvent`, `TradingViewInstrumentMapping`, and `Setup.source: "TRADINGVIEW"`. See `docs/tradingview-setup.md` for the full ingestion pipeline and `docs/tradingview-security.md` for production hardening. **Milestone 5 (now implemented) gives `TradeScreenshot` a real internal chart renderer and Playwright capture pipeline** — see "Screenshots" below and `docs/screenshot-design.md`. Runtime AI agents remain future milestones; see `docs/roadmap.md`.

## Decision-time integrity

Pre-trade information is never contaminated by post-trade information:

**Pre-trade** (immutable once recorded): `MarketSnapshot`, the `Setup` it backs, each `RiskCalculation`. None of these have an update path in `packages/database` — a `Setup` that needs fresher context gets a *new* `MarketSnapshot`/`RiskCalculation` row, never a mutation of an old one. A `Setup`'s only mutable surface is its state-machine fields — `status`, `decisionSummary`, and (implicitly, via Prisma's `@updatedAt`) `updatedAt`. `expiresAt` is set once at creation and is **not** actually mutable after that: `transitionSetupStatus`'s update (see `packages/database/src/repositories/setups.ts`) only ever writes `status`/`decisionSummary`, and `TransitionSetupStatusInput`/`updateSetupStatusSchema` accept no `expiresAt` field at all — corrected here after the Milestone 2 audit found the previous wording overstated `expiresAt`'s mutability. `plannedEntry`/`plannedStop`/`plannedTarget1`/`plannedTarget2`/`marketSnapshotId` are likewise set once at creation and never touched by any exposed function.

**Post-trade** (recorded later, separately): `JournalTrade`'s actual-entry/actual-exit/P&L/MFE/MAE fields (set once, at `recordJournalTradeEntry`/`closeJournalTrade` time), and `PostTradeAnalysis`.

## Market snapshots

`MarketSnapshot` captures what the market looked like at a moment in time: an instrument/timeframe, a candle-window reference (`windowCandleCount`, `windowStartTimestamp`, `windowEndTimestamp`), per-timeframe trend labels (`trend1m`…`trend1d`, free-form strings for now), ATR and its percentile, volume and its percentile, VWAP and distance to it, nearest support/resistance and distance, session/time-of-day/day-of-week, a free-form `marketRegime` (the formal `RegimeAgent` taxonomy is Milestone 7), and a `metadata` JSON catch-all. Not every field is populated in Milestone 2 — the schema is intentionally wider than any single caller needs today.

## The Setup lifecycle

```
WATCH ──▶ PREPARE ──▶ READY ──▶ (human/agent takes or skips it)
  │           │          │
  └────────┬──┴──────────┘
           ▼
  REJECTED / INVALIDATED / EXPIRED   (terminal — no further transitions)
```

Exact matrix enforced by `packages/database`'s `transitionSetupStatus` (see `isAllowedSetupTransition` in `packages/database/src/repositories/setups.ts`): `WATCH → {PREPARE, READY, REJECTED, INVALIDATED, EXPIRED}`, `PREPARE → {READY, REJECTED, INVALIDATED, EXPIRED}`, `READY → {REJECTED, INVALIDATED, EXPIRED}`. No backward transitions, no same-status no-op, no transition out of a terminal status — every violation throws a typed `SetupTransitionError`, translated to HTTP 409 by `apps/api`.

A `Setup` can originate from `BACKTEST` (correlated to an existing deterministic result), `MANUAL_TEST` (a human exercising the journal), `SYSTEM` (an internal process), or `TRADINGVIEW` (a live webhook alert, Milestone 3; see `docs/tradingview-setup.md`). See `SetupSource`.

`plannedStop`/`plannedTarget1` are nullable on `Setup` (Milestone 3): a `TRADINGVIEW`-sourced setup often begins with only a candidate entry (the alert bar's close price). The stop/target genuinely aren't known yet, and unknown information stays unknown rather than fabricated. `createRiskCalculation` rejects with a typed `SetupIncompletePlanError` (HTTP 409) if either is still missing when a risk calculation is requested, since calculating risk without a stop/target is mathematically undefined, not a value to guess at.

## Journal events (append-only)

An append-only event log, not a replacement for the relational tables above: `packages/database`'s `journal-events.ts` repository exposes only `createJournalEvent`/`listJournalEvents`/`getSetupTimeline`, never an update or delete. The event vocabulary (`JournalEventType`): `SETUP_CREATED`, `STRATEGY_EVALUATED`, `RISK_CALCULATED`, `SETUP_APPROVED`/`SETUP_REJECTED`/`SETUP_INVALIDATED`/`SETUP_EXPIRED`, `TRADE_READY`, `TRADE_EXECUTED`, `TRADE_SKIPPED`, `TRADE_CLOSED`, `POST_TRADE_ANALYSIS_CREATED`, `STRATEGY_VERSION_PROPOSED` (Milestone 2), plus `WEBHOOK_RECEIVED`, `WEBHOOK_NORMALIZED`, `SIGNAL_ACCEPTED`, `WEBHOOK_DUPLICATE_DETECTED`, `WEBHOOK_REJECTED`, `WEBHOOK_PROCESSING_FAILED` (Milestone 3; see "TradingView webhook ingestion" below). Later milestones add `AGENT_STARTED`/`AGENT_COMPLETED`/`AGENT_FAILED`, `RESEARCH_HYPOTHESIS_CREATED`, `STRATEGY_VERSION_APPROVED`, `STRATEGY_PAUSED`, etc. via a small additive migration once the runtime agents that emit them exist; they are deliberately not pre-added now.

`createStrategyVersion` (Milestone 1, still immutable-versions-only, no update path) emits `STRATEGY_VERSION_PROPOSED` alongside the create, in the same transaction — a `StrategyVersion` row is never created without a corresponding journal entry.

**Timeline reconstruction**: every event in a `Setup`'s lifecycle — including the events emitted by a `JournalTrade` created from it — shares `correlationId = setup.id`. `getSetupTimeline(setupId)` is therefore a single indexed query (`WHERE correlationId = ? ORDER BY timestamp ASC`), not a multi-table join across `Setup`/`RiskCalculation`/`JournalTrade`. Exact emission mapping:

| Action | Event(s) emitted |
|---|---|
| `createSetup` | `SETUP_CREATED`, plus `STRATEGY_EVALUATED` iff `source === "BACKTEST"` |
| `transitionSetupStatus` → `PREPARE` | *(none — no matching type in the fixed vocabulary; a deliberate, documented gap)* |
| `transitionSetupStatus` → `READY` | `SETUP_APPROVED` |
| `transitionSetupStatus` → `REJECTED` / `INVALIDATED` / `EXPIRED` | `SETUP_REJECTED` / `SETUP_INVALIDATED` / `SETUP_EXPIRED` |
| `createRiskCalculation` | `RISK_CALCULATED` |
| `createJournalTrade` (`executionMode: SKIPPED`) | `TRADE_SKIPPED` |
| `createJournalTrade` (`executionMode: PAPER`/`MANUAL_LIVE`) | `TRADE_READY` |
| `recordJournalTradeEntry` | `TRADE_EXECUTED` |
| `closeJournalTrade` | `TRADE_CLOSED` |
| `createPostTradeAnalysis` | `POST_TRADE_ANALYSIS_CREATED` |

Every state change and its accompanying event are written inside one `prisma.$transaction` — an event is never recorded without its matching change, or vice versa.

## TradingView webhook ingestion (Milestone 3)

Full pipeline and payload format: `docs/tradingview-setup.md`. Production hardening: `docs/tradingview-security.md`. Summary of how this milestone extends the journal architecture, not replaces it:

- **`InboundWebhookEvent`** is the durable record of one physical webhook delivery: `provider`, `receivedAt`, `schemaVersion`, `rawPayload`, `normalizedPayload`, a unique `fingerprint`, `processingStatus` (`RECEIVED → QUEUED → PROCESSING → PROCESSED | REJECTED | FAILED | UNSUPPORTED`), and (once resolved) `setupId`. The `fingerprint`'s database `@unique` constraint is the actual idempotency guarantee: a duplicate delivery cannot even be inserted, so it is structurally impossible for a duplicate to create a second `Setup`. (`WebhookProcessingStatus` also defines `DUPLICATE`, but it is reserved and never actually set: a repeat delivery never gets its own row to set a status on, and the original row's status is deliberately never overwritten. See the type's own doc comment in `packages/shared-types/src/enums.ts`.)
- **`TradingViewInstrumentMapping`** is an explicit `exchange`+`symbol` → `Instrument` mapping. An unmapped symbol is rejected (`UNKNOWN_INSTRUMENT`); an `Instrument` is never auto-created from webhook data.
- **A different `correlationId` convention applies before a `Setup` exists.** Milestone 2's rule ("every event in a Setup's lifecycle shares `correlationId = setup.id`") still holds once a `Setup` exists, but `WEBHOOK_RECEIVED`/`WEBHOOK_NORMALIZED`/`WEBHOOK_DUPLICATE_DETECTED`/`WEBHOOK_REJECTED`/`WEBHOOK_PROCESSING_FAILED` all happen *before* that: a webhook can be rejected (unknown instrument, unknown strategy version, malformed payload) with no `Setup` ever created. These events are instead correlated on the `InboundWebhookEvent`'s own id. `SIGNAL_ACCEPTED` is the bridge: emitted with `correlationId = webhookEvent.id` but `entityType: "SETUP"` / `entityId: setup.id`, so `packages/database`'s `getFullTradingViewTimeline(webhookEventId)` can reconstruct the complete chain, `WEBHOOK_RECEIVED → WEBHOOK_NORMALIZED → SETUP_CREATED → SIGNAL_ACCEPTED → ...` (`SIGNAL_ACCEPTED` necessarily comes after `SETUP_CREATED`, since it records the `Setup` that resolution just produced), by merging the webhook's own event group with the resulting Setup's event group (looked up via `InboundWebhookEvent.setupId`) into one chronologically sorted list.
- **Resolution never guesses.** Both instrument resolution (`TradingViewInstrumentMapping`) and strategy/version resolution (`findStrategyVersionByKeyAndVersion`, exact `strategyKey` + `strategyVersion` match, never "latest") either succeed or the webhook is rejected with a specific `failureCode` (`UNKNOWN_INSTRUMENT`, `UNKNOWN_STRATEGY_VERSION`, `UNSUPPORTED_SIGNAL_TYPE`, `UNSUPPORTED_TIMEFRAME`, `MALFORMED_PAYLOAD`, `UNSUPPORTED_SCHEMA_VERSION`). The `InboundWebhookEvent` row is never deleted or hidden on rejection; auditability includes knowing what was rejected and why.
- **A `TRADINGVIEW`-sourced `Setup` begins in `WATCH`** with only `plannedEntry` (the alert bar's close). See the "Setup lifecycle" section above for why `plannedStop`/`plannedTarget1` stay `null` until a `RiskCalculation` (or a human) supplies them.

## Risk calculations

Every `RiskCalculation` is produced by calling `packages/risk-engine` directly (`calculateStopDistancePoints`/`Ticks`, `calculateRiskBudget`, `calculateRiskPerContract`, `calculatePositionSize`, `calculateRiskReward`) against a `Setup`'s planned entry/stop/target and its `Instrument`'s tick/point/commission values — never computed independently in a controller or the dashboard. `calculatedQuantity: 0` is a valid, persisted outcome (the account can't afford one contract at this risk), not an error.

## Journal trades

`JournalTrade` is **distinct from Milestone 1's `BacktestTrade` by design**, not an oversight: a `BacktestTrade` is the deterministic result of `packages/backtester` running historical candles through a strategy version; a `JournalTrade` is a record of a real (`PAPER`/`MANUAL_LIVE`) trade or a deliberately `SKIPPED` one. Neither table is copied into the other — see "Backtest → journal compatibility" below. `executionMode: "BACKTEST"` exists in the shared `ExecutionMode` enum only for the normalized analytics view (below); no literal `JournalTrade` row is ever created with it.

Lifecycle: `PLANNED` (created, not yet entered) → `OPEN` (`recordJournalTradeEntry`) → `CLOSED` (`closeJournalTrade`, computes `grossPnl`/`netPnl`/`rMultiple` via `packages/risk-engine`'s `calculateGrossPnl`/`calculateNetPnl`/`calculateRMultiple` — never inline arithmetic). `SKIPPED` trades go directly to `SKIPPED` status at creation, bypassing `PLANNED` entirely — they were never taken, so they never "open." `rMultiple` is `null` whenever there's no real risk baseline (`plannedRisk` was never set, or was explicitly `0` — both treated identically, since a caller can't distinguish "unset" from "zero" through the API), never fabricated as `0`.

## Backtest → journal compatibility

`packages/database`'s `getNormalizedTrades()` (the "analytics adapter") merges closed `JournalTrade` rows and all `BacktestTrade` rows into one shared shape — `NormalizedTrade`, defined in `packages/trading-domain` — **in memory, at query time**, without physically duplicating either table. `packages/analytics` (deterministic, no database dependency) operates only on `NormalizedTrade[]`, so grouping and winner/loser comparisons work uniformly across a strategy's backtested and real trading history without ever conflating "what a backtest said would have happened" with "what actually happened."

## Rejected and skipped setups

Rejected and skipped setups remain fully queryable (`GET /setups?status=REJECTED`, etc.) — nothing is ever deleted. Without them, filtering quality (did a rejection actually avoid a bad trade?) cannot be measured later. Hypothetical-outcome tracking for a rejected setup (what would have happened if taken) is future work — not built in Milestone 2 — and when it exists it must be clearly labeled simulated and never mixed into real `JournalTrade`/`BacktestTrade` P&L reporting.

## Winner and loser analysis

`packages/analytics`' `compareWinnersLosers` never concludes "X causes losses" purely because X is common among losing trades — it reports sample size, prevalence, average R, and profit factor across losers, winners, and all trades together, and (when a condition predicate is supplied) the same broken out with/without that condition. No AI interpretation layer exists yet; the numbers are the entire output.

## Post-trade analysis

`PostTradeAnalysis` (`outcome`, `primaryCause`/`contributingFactors` from the `LossCategory` enum, `confidence`, `evidence`, `researchHypotheses`) references either a `JournalTrade` or a `BacktestTrade` via `tradeId` + `tradeSource` (a polymorphic reference — Prisma has no cross-table foreign key, so this is validated at the application layer, not the database). **Nothing in this codebase writes this table automatically.** A row means a genuine analysis mechanism (not built yet) produced it, never a placeholder or a guess.

## Agent execution audit (future)

Still not implemented — `AgentExecution` remains a forward-declared type in `packages/trading-domain/src/future.ts` for Milestone 6+ (runtime AI agents). When built: `id`, `setupId`, `tradeId`, `agentType`/`agentVersion`, `provider`/`model`/`promptTemplateVersion`, `startedAt`/`completedAt`/`latencyMs`, `status`, `structuredInput`/`structuredOutput` (JSON), `decision`, `confidence`, `reasoningSummary`, token/cost fields, `errorCode`/`errorMessage`. Hidden chain-of-thought is never stored — only structured output and a concise audit summary.

## Agent value measurement (future)

Once runtime agents exist, they are evaluated on observed historical outcomes via `packages/analytics`, never on how convincing their explanation sounds: performance when an agent approves vs. rejects, hypothetical performance of agent-rejected setups, performance when multiple agents agree vs. disagree.

## Screenshots

`TradeScreenshot` (Milestone 2 schema, Milestone 5 real pipeline): `id`, `setupId`/`tradeId`+`tradeSource` (polymorphic, same pattern as `PostTradeAnalysis`), `type` (`PRE_TRADE`/`POST_TRADE`), `status` (`REQUESTED`/`GENERATING`/`READY`/`FAILED`), `storageKey`, `mimeType`, `width`/`height`, `marketSnapshotId`, `chartConfigVersion`, `failureCode`/`failureMessage`, `createdAt`/`updatedAt`. Metadata only — the image itself lives in object storage (local disk in development today; the interface is designed to swap in an S3-compatible backend later, not built yet), never as a blob in Postgres.

A real internal chart renderer (`apps/dashboard`'s two internal-only render routes) plus a Playwright capture worker (`apps/worker`) now populate this automatically: a PRE_TRADE screenshot is requested when a `Setup` reaches `READY`, a POST_TRADE screenshot is requested when a `JournalTrade` closes (skipped for a trade with no `Setup` lineage — no `MarketSnapshot` means no chart context). Both triggers are best-effort side effects that never fail the transition/close they're attached to. Full design, the cutoff rule that keeps each screenshot type provably free of look-ahead, the render-ready contract, storage layout, and the failure-code list: `docs/screenshot-design.md`.

The `PRE_TRADE` image is never overwritten after the trade closes — a `READY` row is immutable historical evidence. The two `@@unique` database constraints (`[setupId, type, chartConfigVersion]` and `[tradeId, tradeSource, type, chartConfigVersion]`) enforce that a repeat request can never create a *second* row for the same target; they do not by themselves stop an `UPDATE` on a row that already exists. Immutability of an already-`READY` row's fields is a convention-based guarantee, the same pattern `JournalEvent`'s append-only design uses: no exposed function in `trade-screenshots.ts` ever issues an `UPDATE` against a row whose status is already `READY` (see `docs/screenshot-design.md` for the conditional-`updateMany` mechanism that enforces this in application code). A rendering-behavior change bumps `chartConfigVersion` and creates a new row rather than mutating an old one.

## Analytics filtering surface

`packages/analytics`' `groupTradeAnalytics` currently groups by strategy, strategy version, instrument, direction, and execution mode (`GroupByField`), defaulting to `["strategyId", "strategyVersionId"]` (`DEFAULT_GROUP_BY`) so strategy versions are **never silently combined** — a caller must explicitly ask for a coarser grouping to merge them. Session/hour/day-of-week/market-regime/volatility-regime grouping is future work, gated on that structured data actually being populated on `MarketSnapshot` and joined through.

## Auditability

Every `Setup`, `RiskCalculation`, `JournalTrade`, and `JournalEvent` row carries its `instrumentId`/`strategyId`/`strategyVersionId` (where applicable), so months later it remains possible to reconstruct what the market looked like, what strategy/version was active, what was calculated, what was decided, and what actually happened — without depending on anyone's memory of it.
