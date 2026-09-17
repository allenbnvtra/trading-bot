# Implementation Status

Living progress tracker for Milestone 1. Update as work lands; do not let this drift from reality.

## Completed

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
- Documentation: `docs/architecture.md`, `docs/backtesting-assumptions.md`, `docs/research-methodology.md`, `docs/trade-journal-design.md`, `docs/screenshot-design.md`, `docs/roadmap.md`, `README.md`.

## In progress

- `apps/dashboard`: Next.js research UI (strategy/backtest overview, trades table, trade detail with surrounding candles).

## Remaining

- Final workspace-wide install, build, lint, typecheck, test verification once the dashboard lands.
- Architecture review (system-architect), research-methodology review (research-methodologist), final quality review (quality-reviewer).

## Known decisions

- `Candle.timeframe` and `Backtest.timeframe` are plain `String` columns validated against `TIMEFRAMES`, not Prisma enums — Prisma enum values must be valid identifiers and values like `"1m"` are not.
- Same-candle stop-and-target ambiguity resolves to "stop hit first" (see `docs/backtesting-assumptions.md`).
- Entry timing is next-bar open after a signal candle's close, to prevent look-ahead bias.
- Test runner is Vitest across every package and app for a coherent toolchain, including the NestJS apps (`@nestjs/testing` has no Jest-specific dependency).
- BullMQ queue name `"backtest-run"`, job name `"run"`, payload `{ backtestId }` only — the worker re-fetches everything else from Postgres so the job payload never goes stale relative to the DB.
- Same-candle stop-and-target exits apply the same adverse slippage as a plain STOP exit, for consistency (fixed after an initial pass omitted it).

## Known blockers

(none yet — update as they appear)

## Local environment notes

- On this machine, port 6379 is already used by an unrelated project's Redis container, so local `.env` maps `REDIS_PORT=6380` / `REDIS_URL=redis://localhost:6380`. `.env.example` still documents the conventional default (6379) since a clean machine won't have this conflict.
