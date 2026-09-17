# Implementation Status

Living progress tracker. Update as work lands; do not let this drift from reality.

**Milestone 1: COMPLETE.** All quality gates pass (lint/typecheck/test/build), the full vertical slice is verified end-to-end against a live Postgres/Redis (real backtest via HTTP, deterministic rerun confirmed, QUEUED->COMPLETED transition observed live in the dashboard), and independent architecture/research-methodology/quality reviews all returned GO with zero BLOCKER/HIGH findings.

**Milestone 2: COMPLETE.** All quality gates pass, the full journal pipeline is verified end-to-end against live Postgres/Redis, and independent architecture/journal-completeness/research-methodology/quality reviews are all resolved — one HIGH finding (normalized-trade merge ordering, corrupting drawdown/streak metrics) and several smaller items, all fixed and re-verified.

**Milestone 3: COMPLETE.** All quality gates pass, the full webhook-to-Setup pipeline (all 7 documented fixture behaviors) is verified end-to-end against live Postgres/Redis/HTTP, and independent architecture/journal-completeness/quality reviews are all resolved: one BLOCKER (a BullMQ retry could create a duplicate `Setup` from one webhook delivery), one HIGH (malformed-envelope/v1-shape rejections weren't durably persisted), and several MEDIUM/LOW findings, all fixed and re-verified.

## Milestone 1 — Completed

- Claude Code configuration: root `CLAUDE.md`, `.claude/agents/*.md` (system-architect, quant-engineer, data-engineer, backend-engineer, frontend-engineer, platform-engineer, research-methodologist, journal-analyst, quality-reviewer).
- Workspace scaffolding: pnpm workspace, Turborepo pipeline, root TypeScript/ESLint/Prettier config, `.env.example`, `infra/docker-compose.yml` (Postgres 16 + Redis 7).
- `packages/shared-types`: enums, CSV candle schema, instrument/backtest request schemas.
- `packages/trading-domain`: Milestone 1 entity interfaces + forward-declared future-milestone interfaces.
- `packages/database`: Prisma schema/migration, streaming CSV importer, repositories, seed data — verified against a live Postgres (migration applied, seed idempotency confirmed, CSV import smoke-tested).
- `packages/strategy-engine`: EMA/ATR indicators (explicit warm-up), EMA Trend Pullback v1.0.0 — 28 tests.
- `packages/risk-engine`: deterministic sizing/risk math, rejects invalid input — 34 tests.
- `packages/backtester`: deterministic backtest engine + metrics (next-bar entry, conservative same-candle stop/target, slippage/commissions/MFE/MAE) — 22 tests, including a determinism check.
- `apps/api`: NestJS (Health/Instrument/MarketData/Strategy/Backtest modules), Zod validation pipe, BullMQ producer — verified end-to-end against live Postgres/Redis (created and completed a real backtest via HTTP, 33 trades + computed metrics; a second identical run produced byte-identical trades/metrics).
- `apps/worker`: BullMQ consumer running `packages/backtester`, idempotent on retry (transactional replace).
- `apps/dashboard`: Next.js research UI — Dashboard/Research/Strategies/Backtests/Market Data nav, create-backtest form, live status polling, metrics/trades table, trade detail with surrounding candles, CSV import form. Verified rendering against the live API via headless Chromium.
- Documentation: `docs/architecture.md`, `docs/backtesting-assumptions.md`, `docs/research-methodology.md`, `docs/trade-journal-design.md`, `docs/screenshot-design.md`, `docs/roadmap.md`, `README.md`.
- Final review pass: system-architect (no blockers), research-methodologist (no blockers; independently re-derived the backtest result to confirm it's honest and untuned), quality-reviewer (GO; 0 BLOCKER/HIGH, 1 MEDIUM + 2 LOW, all addressed — see "Known decisions").

## Milestone 2 — Completed

- `packages/shared-types`: `SetupStatus`/`SetupSource`/`ExecutionMode`/`JournalTradeStatus`/`TradeSource`/`PostTradeOutcome`/`LossCategory`/`JournalEventType`/`JournalEntityType`/`ScreenshotType` enums; Zod DTOs for creating/transitioning setups, risk calculations, and journal trades (`journal.ts`) — 18 new tests.
- `packages/trading-domain`: `MarketSnapshot`/`Setup`/`RiskCalculation`/`JournalTrade`/`JournalEvent`/`PostTradeAnalysis`/`TradeScreenshot`/`NormalizedTrade` promoted to real entities (`journal-entities.ts`); `Signal`/`AgentExecution`/`TradeTicket` remain in `future.ts` for Milestone 3+.
- `packages/risk-engine`: added `calculateGrossPnl`/`calculateNetPnl`/`calculateRMultiple` — 10 new tests (47 total).
- `packages/database`: migration `20260917161439_add_journal_analytics_foundation` (7 new tables), repositories for every Milestone 2 model (Setup's transition matrix fully validated, journal events emitted atomically alongside every state change), `getNormalizedTrades()` backtest↔journal analytics adapter, one demo Setup lifecycle added to the seed script — verified end-to-end against live Postgres via a full integration test (setup → snapshot → risk calc → journal events → paper trade → close → timeline → normalized-trade analytics).
- `packages/analytics` (new): `calculateTradeAnalytics`, `groupTradeAnalytics` (`DEFAULT_GROUP_BY` never silently merges strategy versions), `compareWinnersLosers` — zero database dependency, 22 tests.
- `apps/api`: `MarketSnapshotModule`, `SetupModule`, `JournalModule`, `AnalyticsModule`; a global `DomainErrorFilter` translates repository errors to 404/409 — verified end-to-end against live Postgres/Redis with real numbers (105 normalized trades merging 104 Milestone 1 backtest trades + 1 new journal trade).
- `apps/dashboard`: `/journal`, `/trades`, `/analytics` pages + nav update — verified against the live API (real 404 handling, real numbers matching the raw API response, a real demo trade's 7-event setup timeline rendered in order).
- Final review pass: system-architect (no blockers; 2 LOW items, both fixed), journal-analyst (no integrity issues; corrected 2 doc inaccuracies and found the `STRATEGY_VERSION_PROPOSED` gap below, now closed), research-methodologist (no causal-language/null-handling/silent-merge issues; 1 MEDIUM — `/analytics` lacked a trust disclaimer — fixed), quality-reviewer (1 HIGH — `getNormalizedTrades()` wasn't chronologically ordered, corrupting drawdown/streak metrics — fixed and re-verified; everything else clean).

## Milestone 3 — Completed

- `packages/shared-types`: `tradingview.ts` (envelope/v1 Zod schemas, deterministic SHA-256 fingerprint, TradingView-interval-to-`Timeframe` mapping, `normalizeTradingViewPayload`, decimal-based candle invariant checks), `realtime.ts` (`REALTIME_CHANNEL`, discriminated-union `RealtimeEvent` schema), `setup-expiration.ts` (BullMQ queue contract), 111 new tests across the package. New `WebhookProvider`/`WebhookProcessingStatus`/`WebhookFailureCode`/`TradingViewSignalType` enums and `SetupSource: "TRADINGVIEW"`, `JournalEventType`/`JournalEntityType` additions.
- `packages/trading-domain`: `InboundWebhookEvent`/`TradingViewInstrumentMapping`/`NormalizedSignal` entities; `Setup.plannedStop`/`plannedTarget1` made nullable (a TradingView-sourced setup often begins with only a candidate entry) and `Setup.sourceWebhookEventId` added (idempotency, see below).
- `packages/database`: migrations `20260917192801_add_tradingview_webhook_ingestion` and `20260918053000_add_setup_source_webhook_event_id`; `inbound-webhook-events.ts` and `tradingview-instrument-mappings.ts` repositories, `findStrategyVersionByKeyAndVersion`, `findSetupBySourceWebhookEventId`, `SetupIncompletePlanError`, verified end-to-end against live Postgres, including a genuine `Promise.all` concurrency test proving the fingerprint's database `@unique` constraint (not check-then-insert) makes duplicate delivery race-safe.
- `apps/api`: `POST /webhooks/tradingview` (envelope/v1 validation funnel, rate-limited via `@nestjs/throttler`, all rejection paths durably persisted), `GET /webhooks/tradingview/events[/:id[/timeline]]` admin/inspection endpoints, a WebSocket realtime gateway (`@nestjs/websockets` + socket.io) forwarding Redis pub/sub events, `GET /health` extended with real `tradingViewIngestion` status.
- `apps/worker`: `TradingViewWebhookProcessor` (normalize → resolve instrument/strategy → `MarketSnapshot` → `Setup` → journal, retry-safe via `Setup.sourceWebhookEventId`'s uniqueness), `SetupExpirationProcessor` (delayed BullMQ job, never overwrites a terminal status), a shared realtime publisher. Both new queues configured with `attempts: 3` + exponential backoff.
- `apps/dashboard`: `/live-setups` (live table + WebSocket, reconnect reloads from REST API), `/setups/:id` (new Setup detail page; none existed before), `/webhook-events[/:id]` admin/inspection pages, nav update.
- Also fixed in this milestone: apps/api's and apps/worker's `dev` scripts were silently broken (`tsx watch`'s esbuild transpilation doesn't emit the TypeScript decorator metadata NestJS's dependency injection depends on, so any implicitly-injected constructor-based provider read as `undefined` at request time). Switched to `tsc --watch` + `node --watch dist/main.js`. This predated Milestone 3 and was not previously caught because prior milestones' manual verification happened to exercise only explicitly-tokened providers or compiled builds.
- Final review pass: system-architect (no BLOCKER/HIGH; 2 MEDIUM: missing retry policy, fixed; a narrow ingestion-crash window left as a documented known limitation), journal-analyst (1 BLOCKER: a retry could create a duplicate `Setup`, fixed with a `Setup.sourceWebhookEventId` unique constraint mirroring the existing fingerprint pattern; 1 HIGH: malformed rejections weren't persisted, fixed; smaller findings on a dead/unreachable `DUPLICATE` status and timeline-merge documentation, corrected), quality-reviewer (1 MEDIUM: bare `Number()` in a candle-invariant check inconsistent with the project's Decimal discipline, fixed; GO otherwise).

## Remaining

(none currently outstanding; see `docs/roadmap.md` for Milestone 5+. There is no separate "Milestone 4," see `docs/roadmap.md`'s note.)

## Known decisions

- `Candle.timeframe` and `Backtest.timeframe` are plain `String` columns validated against `TIMEFRAMES`, not Prisma enums — Prisma enum values must be valid identifiers and values like `"1m"` are not.
- Same-candle stop-and-target ambiguity resolves to "stop hit first" (see `docs/backtesting-assumptions.md`).
- Entry timing is next-bar open after a signal candle's close, to prevent look-ahead bias.
- Test runner is Vitest across every package and app for a coherent toolchain, including the NestJS apps (`@nestjs/testing` has no Jest-specific dependency).
- BullMQ queue name `"backtest-run"`, job name `"run"`, payload `{ backtestId }` only — the worker re-fetches everything else from Postgres so the job payload never goes stale relative to the DB.
- Same-candle stop-and-target exits apply the same adverse slippage as a plain STOP exit, for consistency (fixed after an initial pass omitted it).
- `initialBalance`, `tickSize`, `tickValue`, `pointValue` reject a zero value at the API/schema boundary (synchronous 400) rather than only failing later inside `packages/risk-engine`; `commissionPerContract` and `riskPercentage` still legitimately allow zero. `POST /backtests` also rejects `startDate >= endDate`.
- The dashboard's Research pages show a persistent banner noting the synthetic data and untuned strategy parameters, so that context isn't only discoverable in `docs/`.
- `JournalTrade` is intentionally distinct from `BacktestTrade` — never duplicated into it. `packages/database`'s `getNormalizedTrades()` merges both in memory at query time for `packages/analytics`.
- `JournalEvent.eventType`/`entityType` are real Prisma enums (stronger DB-level validation), not plain strings, unlike `Candle.timeframe` — their value sets don't start with digits, so the Prisma-enum-identifier problem that forced `timeframe` to be a string doesn't apply here.
- Every event in a `Setup`'s lifecycle (including its `JournalTrade`'s) shares `correlationId = setup.id`, making `GET /setups/:id/timeline` a single indexed query rather than a cross-table join.
- A `plannedRisk` of exactly `"0"` on a `JournalTrade` is treated identically to `null` (no risk baseline) at close time — `rMultiple` is `null`, never a thrown error or a fabricated `0` (a caller can't distinguish "unset" from "typed zero" through the API, so both get the same safe handling).
- `NestJS`'s `@UsePipes` at the method level applies to *every* parameter, not just `@Body()` — any handler combining `@Param()` with a Zod-validated body must apply `ZodValidationPipe` at the parameter (`@Body(new ZodValidationPipe(schema))`), not the method, or the path param gets incorrectly validated against the body schema too.
- `getNormalizedTrades()` sorts its merged output by `entryTimestamp` (both source queries are also individually ordered, but concatenating two sorted lists doesn't itself produce a globally sorted one) — `packages/analytics` never re-sorts, so this is the only place ordering can be guaranteed.
- `createPostTradeAnalysis` verifies the referenced `BacktestTrade`/`JournalTrade` exists before inserting (404 via `NotFoundError` otherwise) — the only integrity check available for a polymorphic reference that can't have a real database foreign key.
- `createStrategyVersion` emits `STRATEGY_VERSION_PROPOSED` in the same transaction as the create — no `StrategyVersion` row exists without a corresponding journal entry.
- `/analytics` and its strategy-version detail page carry an `AnalyticsDisclaimer` banner (mirroring `/research`'s `ResearchDisclaimer`) since a single row can blend simulated backtest trades and real/paper journal trades — check the trades table's `Source` column before treating a number as evidence about live performance.
- `InboundWebhookEvent.fingerprint` excludes `firedAt` (wall-clock delivery time) and the OHLCV fields from its canonicalized input, keyed only on `provider/strategyKey/strategyVersion/exchange/symbol/timeframe/signal/direction/barTime`. A genuine retry of the same trigger can have a different `firedAt`, and including OHLCV would make the fingerprint fragile to harmless formatting differences between deliveries of the same bar.
- Instrument and strategy resolution for a TradingView webhook never guess: an unmapped `exchange`/`symbol` is `UNKNOWN_INSTRUMENT`, an unmatched `strategyKey`/`strategyVersion` pair is `UNKNOWN_STRATEGY_VERSION` (never "fall back to latest version"), both rejected with the `InboundWebhookEvent` row kept for audit, never silently dropped.
- `Setup.sourceWebhookEventId` (nullable, `@unique`) is the idempotency guard against a BullMQ retry creating a second `Setup` for one webhook delivery: the same "database constraint, not check-then-insert" principle as `fingerprint`, added after a review found the original retry-safety logic checked only `InboundWebhookEvent.processingStatus`, which is insufficient on its own (a crash between `createSetup` and the event being marked `PROCESSED` leaves it at `PROCESSING`/`FAILED`, neither of which blocks reprocessing).
- The setup-expiration BullMQ job is scheduled *before* the `InboundWebhookEvent` is marked `PROCESSED`, not after. Marking `PROCESSED` blocks any future retry, so scheduling first means a crash between the two steps just means a retry (or the sourceWebhookEventId recovery path) schedules the expiration job again, which is harmless, rather than the job never being scheduled at all.
- A synchronously-`400`-rejected webhook delivery (envelope-invalid, or `schemaVersion: 1` but the full v1 shape is invalid) is still durably persisted as `REJECTED`/`MALFORMED_PAYLOAD`, using a fallback fingerprint (a hash of the whole raw body, since the real field-based fingerprint needs specific fields to exist and parse). The HTTP response stays an unchanged, fast, synchronous 400.
- `WebhookProcessingStatus.DUPLICATE` is a reserved enum value, never actually set by any code path: a repeat delivery never gets its own row, and the original row's status is deliberately never overwritten (doing so would incorrectly imply an already-successful delivery was invalidated). "This was redelivered" is conveyed instead via the `wasDuplicate` response flag and a `WEBHOOK_DUPLICATE_DETECTED` journal event.
- `apps/api`'s and `apps/worker`'s `dev` scripts use `tsc --watch` + `node --watch dist/main.js`, not `tsx watch`. `tsx` transpiles via esbuild, which does not emit the TypeScript decorator metadata NestJS's dependency injection depends on for implicit constructor-based injection, so any such provider silently read as `undefined` at request time under the old script.

## Known blockers

(none)

## Local environment notes

- On this machine, port 6379 is already used by an unrelated project's Redis container, so local `.env` maps `REDIS_PORT=6380` / `REDIS_URL=redis://localhost:6380`. `.env.example` still documents the conventional default (6379) since a clean machine won't have this conflict.
