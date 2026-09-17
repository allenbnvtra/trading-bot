# Roadmap

Trading Copilot is built incrementally. Each milestone must be correct, tested, and reviewed before the next begins. Do not skip ahead.

## Milestone 1 — Historical research/backtesting foundation (current)

Historical CSV → validated candles → PostgreSQL → instrument → strategy version → deterministic backtester → persisted trades → performance metrics → NestJS API → Next.js research dashboard → individual trade inspection.

No runtime AI agents. No TradingView. No brokerage connectivity. No automatic execution.

## Milestone 2 — Trade journal foundation + deeper analytics

Journal event model, market snapshots, rejected/skipped trade tracking, winner/loss comparison analytics (see `docs/trade-journal-design.md`).

## Milestone 3 — TradingView webhook ingestion

`POST /webhooks/tradingview`, signed/validated payloads, duplicate-event protection, Setup creation.

## Milestone 4 — Live setup state machine

WATCH → PREPARE → READY → INVALIDATED / EXPIRED / REJECTED. Human executes only after receiving information.

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
