# Trading Copilot

## Mission

Build a personal trading research and decision-support platform.

It is not an automatic execution bot.

Humans execute trades manually.

## Current milestone

Milestone 1:

historical candles
→ deterministic strategies
→ deterministic backtesting
→ persisted trades
→ performance analytics
→ dashboard inspection

Do not skip directly to runtime AI agents.

See `docs/implementation-status.md` for current progress and `docs/roadmap.md` for future milestones.

## Stack

* TypeScript
* pnpm
* Turborepo
* NestJS
* Next.js
* PostgreSQL
* Prisma
* Redis
* BullMQ
* Zod
* Docker Compose
* strict TypeScript

Possible later addition: Python research workers for advanced statistical/ML research.

## Architecture

Use a modular monolith.

Applications:

* apps/api
* apps/dashboard
* apps/worker

Packages:

* packages/database
* packages/trading-domain
* packages/shared-types
* packages/strategy-engine
* packages/backtester
* packages/risk-engine

PostgreSQL is the source of truth.

Redis is ephemeral queue/cache infrastructure.

## Financial rules

All financial calculations must be deterministic.

Do not delegate arithmetic to an LLM.

Use `decimal.js` (or equivalent precision library) where money or trading precision requires it.

Avoid careless JavaScript floating-point arithmetic.

Store timestamps in UTC.

Preserve instrument timezone/session metadata separately.

## Strategy rules

All strategies are versioned.

Never modify historical strategy definitions silently.

Backtests must avoid look-ahead bias.

Backtests must be reproducible.

Trading assumptions must be documented (see `docs/backtesting-assumptions.md`).

## Execution

Do not implement automatic broker order execution.

The human user executes trades manually.

## Coding rules

Use strict TypeScript.

Avoid `any`.

Keep controllers thin.

Keep domain logic independent from NestJS where possible.

Financial logic must not exist in React components.

Validate all external input (Zod / class-validator DTOs).

Test critical calculations.

Avoid premature abstractions.

Do not introduce Kubernetes, Kafka, or microservices without demonstrated need.

## Claude subagents

Use subagents for:

* independent workstreams
* specialized reviews
* isolated context
* parallelizable tasks

Do NOT delegate trivial single-file changes.

Avoid multiple subagents editing the same files concurrently.

The primary Claude session owns integration.

After subagents finish:

* inspect their work
* resolve conflicts
* run tests
* run lint
* run typecheck
* run builds

Subagent output is not automatically correct.

### Ownership

* `system-architect` — architecture review; primarily read-only
* `quant-engineer` — packages/strategy-engine, packages/backtester, packages/risk-engine
* `data-engineer` — PostgreSQL, Prisma, imports, persistence
* `backend-engineer` — NestJS API and BullMQ worker
* `frontend-engineer` — Next.js dashboard
* `platform-engineer` — workspace, Docker, scripts, configuration
* `research-methodologist` — research methodology, experiment design, overfitting safeguards
* `journal-analyst` — journal schema and analytics design
* `quality-reviewer` — final correctness review

Primary/orchestrating agent owns shared contracts and integration.

## Testing priorities

Highest-priority tests:

EMA, ATR, price precision, ticks, points, position sizing, risk calculations,
strategy rules, look-ahead prevention, entry timing, stops, targets,
same-candle stop/target, slippage, commissions, MFE, MAE, drawdowns, metrics,
duplicate candles, deterministic reruns.

## Working style

Build vertically.

Prefer:

data → strategy → backtest → persistence → API → dashboard

over producing many unused abstractions.

Do not optimize the example strategy for profitability.

Correctness comes first.
