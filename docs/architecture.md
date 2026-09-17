# Architecture

Trading Copilot is a modular monolith, not a microservices system. It is a personal research and decision-support tool — humans execute every trade manually, and the system never places broker orders.

## Applications

- **apps/api** — NestJS HTTP API. Thin controllers, DTO validation, delegates all financial/strategy logic to domain packages. Owns writes/reads against PostgreSQL via `packages/database`, and enqueues background work via BullMQ/Redis.
- **apps/worker** — BullMQ job processor (backtest execution, future market-data import jobs). Calls the same domain packages as the API — never reimplements backtesting or risk math.
- **apps/dashboard** — Next.js App Router research UI. Renders values computed by the backend; never recomputes financial values client-side.

## Packages

- **packages/shared-types** — Enums and Zod schemas shared by every app and package (asset classes, timeframes, direction, backtest status, CSV row schema, API request schemas). No business logic.
- **packages/trading-domain** — Plain TypeScript domain entities (Instrument, Candle, Strategy, StrategyVersion, Backtest, BacktestTrade, BacktestMetrics) decoupled from Prisma, plus forward-declared future-milestone types (Signal, Setup, MarketSnapshot, AgentExecution, RiskCalculation, TradeTicket, ManualTrade, JournalEvent, PostTradeAnalysis). Depends only on shared-types and decimal.js.
- **packages/strategy-engine** — Deterministic indicators (EMA, ATR) and strategy definitions (EMA Trend Pullback v1.0.0). Pure functions over candle arrays; look-ahead-safe by construction. No database, no HTTP, no AI.
- **packages/risk-engine** — Deterministic position-sizing and risk/reward math. Pure functions, `decimal.js` throughout, rejects invalid input rather than coercing it.
- **packages/backtester** — Deterministic backtesting engine composing strategy-engine + risk-engine over a candle series to produce trades and metrics. No database — the caller (apps/worker) persists the result.
- **packages/database** — Prisma schema/client, migrations, seed data, the candle CSV importer, and repository functions used by apps/api and apps/worker.

## Dependency direction

```
apps/api, apps/worker, apps/dashboard
        │
        ▼
packages/database ──▶ packages/trading-domain ──▶ packages/shared-types
packages/backtester ─▶ packages/strategy-engine ─▶ packages/trading-domain
                    └─▶ packages/risk-engine ─────▶ packages/trading-domain
```

Packages never depend on apps. `strategy-engine`, `risk-engine`, and `backtester` never depend on `database`, NestJS, or Next.js — they are pure domain logic, independently testable and reusable from a future research worker (e.g. Python) if ever needed.

## Source of truth

PostgreSQL is the only persistent source of truth. Redis is ephemeral queue/cache infrastructure (BullMQ job state) — nothing that must survive a `FLUSHALL` lives only in Redis. Nothing depends on LLM memory for historical facts; runtime AI agents (future milestones) query PostgreSQL through the domain packages.

## Where financial logic is allowed to live

Only in `packages/risk-engine`, `packages/strategy-engine`, and `packages/backtester`. It must never appear in:

- NestJS controllers (they validate input and call a domain package/service)
- React/Next.js components (they render already-computed values)
- AI prompts (AI explains numbers; it never produces them)
- Persistence adapters (Prisma mappers convert types; they do not compute financial values)

## Reproducibility and auditability

- `StrategyVersion` rows are immutable once created. Every change is a new version.
- `runBacktest` is a pure function: identical inputs (candles, strategy version, assumptions) always produce identical trades and metrics.
- Every `BacktestTrade` links back to the `StrategyVersion` and `Instrument` that produced it, and every `Backtest` records the assumptions (commission, slippage, risk %) it ran with, so a result can be explained and reproduced later.
