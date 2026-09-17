# Trading Copilot

A personal AI-assisted trading research and decision-support platform.

**This is not an automatic trading bot.** It never places broker orders. The human user manually executes every trade; the system's job is to produce trustworthy, deterministic, auditable research — historical data, deterministic strategies, deterministic backtests, and (in later milestones) AI-assisted analysis that explains numbers without ever calculating them.

See `CLAUDE.md` for the working rules this project is built under, `docs/roadmap.md` for the full milestone plan, and `docs/implementation-status.md` for current progress.

## Architecture

Modular monolith. See `docs/architecture.md` for the full picture.

```
apps/api         NestJS HTTP API (also hosts the TradingView webhook endpoint and a realtime WebSocket gateway)
apps/worker      BullMQ background job processor (runs backtests, processes TradingView webhook events)
apps/dashboard   Next.js research dashboard

packages/database         Prisma schema, migrations, seed data, CSV importer, journal + webhook-ingestion repositories
packages/trading-domain   Domain entity types (Milestone 1-3, plus forward-declared future types)
packages/shared-types     Enums and Zod schemas shared everywhere
packages/strategy-engine  Deterministic indicators + strategy definitions
packages/risk-engine      Deterministic position sizing / risk / trade P&L math
packages/backtester       Deterministic backtest engine + metrics
packages/analytics        Deterministic cross-cutting analytics (grouping, winner/loser comparison)
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

## Trade journal (Milestone 2)

The journal records real (paper/manual-live) trades and every decision that led to them, distinct from Milestone 1's deterministic backtest trades. A full lifecycle, end to end:

```bash
# 1. Record what the market looked like at decision time
curl -X POST http://localhost:3001/market-snapshots -H "Content-Type: application/json" -d '{
  "instrumentId": "<instrument-id>", "timestamp": "2024-06-01T14:00:00.000Z", "timeframe": "1h"
}'

# 2. Create a candidate setup against that snapshot
curl -X POST http://localhost:3001/setups -H "Content-Type: application/json" -d '{
  "instrumentId": "<instrument-id>", "strategyId": "<strategy-id>", "strategyVersionId": "<strategy-version-id>",
  "marketSnapshotId": "<snapshot-id>", "direction": "LONG", "source": "MANUAL_TEST",
  "plannedEntry": "5100", "plannedStop": "5080", "plannedTarget1": "5140"
}'

# 3. Move it through the state machine (WATCH -> PREPARE -> READY; a 409 comes back on any invalid transition)
curl -X PATCH http://localhost:3001/setups/<setup-id>/status -H "Content-Type: application/json" -d '{"status":"PREPARE"}'
curl -X PATCH http://localhost:3001/setups/<setup-id>/status -H "Content-Type: application/json" -d '{"status":"READY"}'

# 4. Get a deterministic risk calculation (packages/risk-engine, never computed client-side)
curl -X POST http://localhost:3001/setups/<setup-id>/risk-calculations -H "Content-Type: application/json" -d '{
  "accountEquity": "50000", "riskPercentage": "1", "slippageTicks": 1
}'

# 5. Record the trade, its entry, and its close
curl -X POST http://localhost:3001/journal/trades -H "Content-Type: application/json" -d '{
  "setupId": "<setup-id>", "instrumentId": "<instrument-id>", "strategyId": "<strategy-id>",
  "strategyVersionId": "<strategy-version-id>", "direction": "LONG",
  "plannedEntry": "5100", "plannedStop": "5080", "executionMode": "PAPER"
}'
curl -X POST http://localhost:3001/journal/trades/<trade-id>/entry -H "Content-Type: application/json" -d '{
  "actualEntry": "5101.5", "entryTimestamp": "2024-06-01T15:00:00.000Z", "quantity": 1
}'
curl -X POST http://localhost:3001/journal/trades/<trade-id>/close -H "Content-Type: application/json" -d '{
  "actualExit": "5138", "exitTimestamp": "2024-06-01T18:00:00.000Z"
}'

# 6. Reconstruct the full decision timeline
curl http://localhost:3001/setups/<setup-id>/timeline
```

## Analytics (Milestone 2)

```bash
curl http://localhost:3001/analytics/strategies                                   # one row per strategy version, never merged
curl http://localhost:3001/analytics/strategies/<id>/versions/<version-id>         # metrics, long vs short, winners vs losers
curl "http://localhost:3001/analytics/comparison?groupBy=instrumentId,direction"   # ad-hoc grouping
curl http://localhost:3001/analytics/winners-losers                               # sample-size-aware winner/loser comparison
```

All of the above draw from `packages/analytics`, running over a merged, normalized view of Milestone 1 backtest trades and Milestone 2 journal trades (`getNormalizedTrades()`) — never duplicated into a third table.

## TradingView webhook ingestion (Milestone 3)

A real TradingView alert becomes a live `Setup` in the trade journal, durably and idempotently, with no automatic order execution anywhere. Full design in `docs/tradingview-setup.md`, production hardening in `docs/tradingview-security.md`.

TradingView cannot reach `localhost`, so local testing POSTs straight to the endpoint using the fixtures in `fixtures/tradingview/`:

```bash
curl -i -X POST http://localhost:3001/webhooks/tradingview \
  -H "Content-Type: application/json" \
  --data @fixtures/tradingview/valid-long.json
```

See `fixtures/tradingview/README.md` for the full fixture list (valid long/short, duplicate, unknown instrument, unknown strategy, malformed, unsupported schema) and exactly what each one should produce. Inspect what happened:

```bash
curl "http://localhost:3001/webhooks/tradingview/events?processingStatus=REJECTED"
curl http://localhost:3001/webhooks/tradingview/events/<event-id>/timeline
curl "http://localhost:3001/setups?source=TRADINGVIEW"
```

To configure a real alert, see `examples/tradingview/ema-trend-pullback-webhook.pine` (a development-only integration-test fixture, not a recommended strategy) and the "Configuring a real TradingView alert" section of `docs/tradingview-setup.md`.

## Dashboard

Once `pnpm dev` is running: http://localhost:3000

- `/live-setups` — live TradingView-sourced setups, updated in realtime over WebSocket, system health at the top
- `/setups/<id>` — a single setup's full detail and journal timeline
- `/webhook-events` — every inbound TradingView webhook delivery, including rejected ones, admin-inspectable
- `/research` — run and inspect backtests
- `/journal` — chronological journal event timeline, filterable
- `/trades` — journal trades (paper/manual-live/skipped), each with its full decision timeline
- `/analytics` — per-strategy-version performance, drill down to long/short and winner/loser breakdowns
- `/strategies`, `/backtests`, `/market-data` — Milestone 1 pages

## Assumptions and design docs

- `docs/backtesting-assumptions.md` — every conservative assumption baked into the backtester (entry timing, same-candle stop/target, slippage, commissions, gaps).
- `docs/research-methodology.md` — the guardrails required before any future AI-driven strategy research is trusted.
- `docs/trade-journal-design.md` — the trade journal / audit schema design (Milestones 2-3, implemented).
- `docs/tradingview-setup.md` — the TradingView webhook ingestion pipeline (Milestone 3, implemented).
- `docs/tradingview-security.md` — production hardening for the webhook endpoint (Milestone 3).
- `docs/screenshot-design.md` — the future chart-screenshot pipeline design (Milestone 5).
