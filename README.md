# Trading Copilot

A personal AI-assisted trading research and decision-support platform.

**This is not an automatic trading bot.** It never places broker orders. The human user manually executes every trade; the system's job is to produce trustworthy, deterministic, auditable research — historical data, deterministic strategies, deterministic backtests, and (in later milestones) AI-assisted analysis that explains numbers without ever calculating them.

See `CLAUDE.md` for the working rules this project is built under, `docs/roadmap.md` for the full milestone plan, and `docs/implementation-status.md` for current progress.

## Architecture

Modular monolith. See `docs/architecture.md` for the full picture.

```
apps/api         NestJS HTTP API
apps/worker      BullMQ background job processor (runs backtests)
apps/dashboard   Next.js research dashboard

packages/database         Prisma schema, migrations, seed data, CSV importer
packages/trading-domain   Domain entity types (Milestone 1 + forward-declared future types)
packages/shared-types     Enums and Zod schemas shared everywhere
packages/strategy-engine  Deterministic indicators + strategy definitions
packages/risk-engine      Deterministic position sizing / risk math
packages/backtester       Deterministic backtest engine + metrics
```

PostgreSQL is the permanent source of truth. Redis is ephemeral queue/cache infrastructure only.

## Local setup

Requirements: Node.js 20+, pnpm 9+, Docker Desktop (or compatible).

```bash
pnpm install
pnpm infra:up          # starts Postgres + Redis via infra/docker-compose.yml
pnpm db:migrate
pnpm db:seed
pnpm dev                # runs apps/api, apps/worker, apps/dashboard together
```

Copy `.env.example` to `.env` first and adjust if needed — the defaults work out of the box with `infra/docker-compose.yml`.

## Commands

```bash
pnpm dev          # start api + worker + dashboard in watch mode
pnpm build        # build everything
pnpm test         # run all tests (Vitest)
pnpm lint         # lint everything
pnpm typecheck    # typecheck everything
pnpm db:migrate   # run Prisma migrations
pnpm db:seed      # seed synthetic development data
pnpm infra:up     # start Postgres + Redis
pnpm infra:down   # stop Postgres + Redis
```

## Importing market data

```bash
curl -X POST http://localhost:3001/market-data/import \
  -F "instrumentId=<instrument-id>" \
  -F "timeframe=1h" \
  -F "file=@fixtures/candles/synthetic-example-1h.csv"
```

`fixtures/candles/` contains **synthetic, clearly labeled** example data for exercising the importer — never real market data. CSV format: `timestamp,open,high,low,close,volume` (timestamp is ISO-8601 UTC).

## Running a backtest

```bash
curl -X POST http://localhost:3001/backtests \
  -H "Content-Type: application/json" \
  -d '{
    "instrumentId": "<instrument-id>",
    "strategyVersionId": "<strategy-version-id>",
    "timeframe": "1h",
    "startDate": "2024-01-01T00:00:00.000Z",
    "endDate": "2024-06-01T00:00:00.000Z",
    "initialBalance": "50000",
    "riskPercentage": "1",
    "slippageTicks": 1
  }'
```

Poll `GET /backtests/:id` for status (`QUEUED` → `RUNNING` → `COMPLETED`/`FAILED`), then `GET /backtests/:id/trades` and `GET /backtests/:id/trades/:tradeId` for results.

## Dashboard

Once `pnpm dev` is running: http://localhost:3000

## Assumptions and design docs

- `docs/backtesting-assumptions.md` — every conservative assumption baked into the backtester (entry timing, same-candle stop/target, slippage, commissions, gaps).
- `docs/research-methodology.md` — the guardrails required before any future AI-driven strategy research is trusted.
- `docs/trade-journal-design.md` — the future trade journal / audit schema design.
- `docs/screenshot-design.md` — the future chart-screenshot pipeline design.
