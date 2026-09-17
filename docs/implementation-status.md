# Implementation Status

Living progress tracker for Milestone 1. Update as work lands; do not let this drift from reality.

## Completed

- Claude Code configuration: root `CLAUDE.md`, `.claude/agents/*.md` (system-architect, quant-engineer, data-engineer, backend-engineer, frontend-engineer, platform-engineer, research-methodologist, journal-analyst, quality-reviewer).
- Workspace scaffolding: pnpm workspace, Turborepo pipeline, root TypeScript/ESLint/Prettier config, `.env.example`, `infra/docker-compose.yml` (Postgres 16 + Redis 7).
- `packages/shared-types`: enums, CSV candle schema, instrument/backtest request schemas.
- `packages/trading-domain`: Milestone 1 entity interfaces + forward-declared future-milestone interfaces.
- Documentation: `docs/architecture.md`, `docs/backtesting-assumptions.md`, `docs/research-methodology.md`, `docs/trade-journal-design.md`, `docs/screenshot-design.md`, `docs/roadmap.md`.

## In progress

- `packages/database`: Prisma schema, migrations, seed data (synthetic, clearly labeled), candle CSV importer, repositories.
- `packages/strategy-engine`: EMA/ATR indicators, EMA Trend Pullback v1.0.0 strategy.
- `packages/risk-engine`: deterministic sizing/risk math.
- `packages/backtester`: deterministic backtest engine + metrics.

## Remaining

- `apps/api`: NestJS modules (Health, Instrument, MarketData, Strategy, Backtest), BullMQ producer.
- `apps/worker`: BullMQ consumer running backtests via the domain packages.
- `apps/dashboard`: Next.js research UI (strategy/backtest overview, trades table, trade detail with surrounding candles).
- Workspace-wide install, build, lint, typecheck, test verification.
- Docker Compose up, migration, seed, end-to-end backtest run, deterministic-rerun check.
- Architecture review (system-architect), research-methodology review (research-methodologist), final quality review (quality-reviewer).
- README.md.

## Known decisions

- `Candle.timeframe` and `Backtest.timeframe` are plain `String` columns validated against `TIMEFRAMES`, not Prisma enums — Prisma enum values must be valid identifiers and values like `"1m"` are not.
- Same-candle stop-and-target ambiguity resolves to "stop hit first" (see `docs/backtesting-assumptions.md`).
- Entry timing is next-bar open after a signal candle's close, to prevent look-ahead bias.
- Test runner is Vitest across every package and app for a coherent toolchain.

## Known blockers

(none yet — update as they appear)
