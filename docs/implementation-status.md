# Implementation Status

Living progress tracker. Update as work lands; do not let this drift from reality.

**Milestone 1: COMPLETE.** All quality gates pass (lint/typecheck/test/build), the full vertical slice is verified end-to-end against a live Postgres/Redis (real backtest via HTTP, deterministic rerun confirmed, QUEUED->COMPLETED transition observed live in the dashboard), and independent architecture/research-methodology/quality reviews all returned GO with zero BLOCKER/HIGH findings.

**Milestone 2: database/analytics/API layers complete and verified end-to-end against live Postgres/Redis; dashboard pages in progress.**

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
## Milestone 2 — In progress

- `apps/dashboard`: `/journal`, `/trades`, `/analytics` pages + nav update (backend is ready and live-verified; dashboard work in flight).

## Remaining

- Final Milestone 2 review pass (system-architect, journal-analyst, research-methodologist, quality-reviewer) once the dashboard lands.

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

## Known blockers

(none)

## Local environment notes

- On this machine, port 6379 is already used by an unrelated project's Redis container, so local `.env` maps `REDIS_PORT=6380` / `REDIS_URL=redis://localhost:6380`. `.env.example` still documents the conventional default (6379) since a clean machine won't have this conflict.
