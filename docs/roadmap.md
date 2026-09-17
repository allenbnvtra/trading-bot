# Roadmap

Trading Copilot is built incrementally. Each milestone must be correct, tested, and reviewed before the next begins. Do not skip ahead.

## Milestone 1 — Historical research/backtesting foundation (complete)

Historical CSV → validated candles → PostgreSQL → instrument → strategy version → deterministic backtester → persisted trades → performance metrics → NestJS API → Next.js research dashboard → individual trade inspection.

No runtime AI agents. No TradingView. No brokerage connectivity. No automatic execution.

## Milestone 2 — Trade journal foundation + deeper analytics (complete)

Market snapshots, the Setup lifecycle (WATCH/PREPARE/READY/REJECTED/INVALIDATED/EXPIRED), persisted risk calculations, journal trades (paper/manual-live/skipped, distinct from Milestone 1's BacktestTrade), an append-only journal event log with full timeline reconstruction, a deterministic cross-cutting analytics engine (grouping + winner/loser comparison) spanning both backtested and real trades, and dashboard pages for all of it (`/journal`, `/trades`, `/analytics`). See `docs/trade-journal-design.md`.

Rejected/skipped setups remain fully queryable, never deleted. `PostTradeAnalysis` and `TradeScreenshot` exist as schema foundations only — nothing auto-populates them yet.

## Milestone 3 — TradingView webhook ingestion + live setup state machine (complete, current)

`POST /webhooks/tradingview`: durable, idempotent (database-unique-constraint-backed), asynchronous ingestion via BullMQ, validated/versioned payloads, explicit instrument/strategy resolution (never auto-created, never "latest"), realtime dashboard updates over WebSocket (Redis pub/sub between `apps/worker` and `apps/api`), and a `/live-setups` dashboard. See `docs/tradingview-setup.md` and `docs/tradingview-security.md`.

The WATCH → PREPARE → READY → INVALIDATED / EXPIRED / REJECTED state machine itself shipped in Milestone 2 and is reused unchanged here; this milestone is what actually drives it from a live, external signal source instead of only backtests/manual test data. Human executes only after receiving information; no automatic execution exists anywhere in this codebase.

*(There is no separate "Milestone 4": its original scope, the live setup state machine, is covered above; later milestone numbers are kept as originally planned rather than renumbered, to avoid a drive-by rename across every doc that cites a milestone number.)*

## Milestone 5 — Chart screenshot generation

Internal chart renderer over stored candles, Playwright screenshot capture, PRE_TRADE / POST_TRADE image types (see `docs/screenshot-design.md`).

## Milestone 6 — AI Research Agent

Hypothesis generation from aggregated historical statistics, under an experiment budget, fully logged.

## Milestone 7 — Structure / Regime / Critic / Event agents

Runtime application agents (not `.claude/agents`) producing structured, audited output.

## Milestone 8 — Winner + Loss Analysis agents

Structured post-trade analysis, hypothesis-only output, never a direct live-strategy mutation.

## Milestone 9 — Telegram/notification system

WATCH/PREPARE/READY/INVALIDATED/EXPIRED notifications with full context; human executes manually.

## Milestone 10 — Read-only broker/account integration

Read-only only. No order placement, ever.

## Milestone 11 — Walk-forward + paper-trading approval pipeline

Formal research → validation → out-of-sample → walk-forward → paper trading → approval pipeline (see `docs/research-methodology.md`).

## Milestone 12 — 24/7 deployment and monitoring

Single small VPS, Docker Compose, reverse proxy, system health surfaced for every dependency. Fail closed: if required data is unavailable, the system reports `SYSTEM_BLOCKED` rather than guessing.

---

Do not implement everything immediately. Implement each milestone correctly before starting the next.
