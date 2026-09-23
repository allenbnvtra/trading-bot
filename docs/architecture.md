# Architecture

Trading Copilot is a modular monolith, not a microservices system. It is a personal research and decision-support tool — humans execute every trade manually, and the system never places broker orders.

## Applications

- **apps/api** - NestJS HTTP API. Thin controllers, DTO validation, delegates all financial/strategy logic to domain packages. Owns writes/reads against PostgreSQL via `packages/database`, and enqueues background work via BullMQ/Redis. Also hosts `POST /webhooks/tradingview` (Milestone 3; see `docs/tradingview-setup.md`) and a WebSocket gateway that rebroadcasts realtime events published by `apps/worker` over Redis pub/sub. Owns the `NotificationDelivery` lifecycle and persistence and the enqueue decision (Milestone 6: `apps/api/src/notifications/notification.service.ts`'s `NotificationService`/`enqueueNotificationIfNeeded`, and `apps/api/src/setups/setup.service.ts`'s `notifyForStatus` notification policy) - see `docs/notifications.md`.
- **apps/worker** - BullMQ job processor: backtest execution (Milestone 1), TradingView webhook event processing (Milestone 3: normalize, resolve instrument/strategy, create `Setup`, journal), Playwright-driven chart screenshot generation (Milestone 5: navigate to an `apps/dashboard` internal render route, wait for its render-ready DOM signal, capture and store a PNG), and the actual outbound notification send (Milestone 6: `apps/worker/src/notifications/`'s `NotificationProvider` implementations - `ConsoleNotificationProvider`/`TelegramNotificationProvider` - and `NotificationSendProcessor`, which formats the message, optionally waits for a screenshot, and calls the provider). Calls the same domain packages as the API and never reimplements backtesting, risk, or normalization math. Publishes realtime notifications to Redis for `apps/api`'s WebSocket gateway to forward; PostgreSQL remains the source of truth regardless, so a reconnecting dashboard client reloads current state from the REST API rather than depending on having seen every pub/sub message.
- **apps/dashboard** - Next.js App Router research UI. Renders values computed by the backend; never recomputes financial values client-side. Also hosts two internal-only render routes (`/internal/render/setup/:setupId`, `/internal/render/trade/:tradeId`, Milestone 5) that draw one annotated chart each for `apps/worker`'s Playwright screenshot capture to load - never linked from normal dashboard navigation and not meant for a human to open directly. Never talks to Telegram (or any notification provider) directly - it only reads `NotificationDelivery` status via `GET /setups/:id/notifications` (Milestone 6) and surfaces the manual PAPER TRADE / I ENTERED THIS TRADE / SKIP TRADE actions on `/setups/:id` (`POST /setups/:id/execute`/`skip`).

## Packages

- **packages/shared-types** - Enums and Zod schemas shared by every app and package (asset classes, timeframes, direction, backtest status, setup/journal/analytics enums, CSV row schema, API request schemas). Also `notifications.ts` (Milestone 6: `NOTIFICATION_QUEUE`/`SEND_NOTIFICATION_JOB` BullMQ contract, `NOTIFICATION_TEMPLATE_VERSION`, the bounded screenshot-wait timing constants, `executeSetupSchema`/`skipSetupSchema`, `isTelegramConfigured` - the single shared implementation of the three-Telegram-env-var check). No business logic.
- **packages/trading-domain** - Plain TypeScript domain entities decoupled from Prisma: Milestone 1's `Instrument`/`Candle`/`Strategy`/`StrategyVersion`/`Backtest`/`BacktestTrade`/`BacktestMetrics` (`entities.ts`), Milestone 2's `MarketSnapshot`/`Setup`/`RiskCalculation`/`JournalTrade`/`JournalEvent`/`PostTradeAnalysis`/`TradeScreenshot`/`NormalizedTrade` (`journal-entities.ts`), Milestone 6's `NotificationDelivery` entity, and forward-declared Milestone 3+ types (`Signal`, `AgentExecution`, `TradeTicket` - `future.ts`). Depends only on shared-types and decimal.js.
- **packages/strategy-engine** — Deterministic indicators (EMA, ATR) and strategy definitions (EMA Trend Pullback v1.0.0). Pure functions over candle arrays; look-ahead-safe by construction. No database, no HTTP, no AI.
- **packages/risk-engine** - Deterministic position-sizing, risk/reward, and trade P&L math (`calculateGrossPnl`/`calculateNetPnl`/`calculateRMultiple`, plus Milestone 6's `calculateExcursions` for server-side MFE/MAE over a candle range). Pure functions, `decimal.js` throughout, rejects invalid input rather than coercing it.
- **packages/backtester** — Deterministic backtesting engine composing strategy-engine + risk-engine over a candle series to produce trades and metrics. No database — the caller (apps/worker) persists the result.
- **packages/analytics** — Deterministic, LLM-free grouping and winner/loser-comparison math over `NormalizedTrade[]` (Milestone 1 `BacktestTrade` and Milestone 2 `JournalTrade`, normalized to one shape by packages/database). No database dependency — mirrors packages/backtester's relationship to raw candle data.
- **packages/database** - Prisma schema/client, migrations, seed data, the candle CSV importer, the Milestone 1 backtest repositories, the Milestone 2 journal repositories (MarketSnapshot/Setup/RiskCalculation/JournalTrade/JournalEvent/PostTradeAnalysis/TradeScreenshot), the Milestone 3 webhook-ingestion repositories (InboundWebhookEvent/TradingViewInstrumentMapping), the Milestone 5 TradeScreenshot lifecycle repository (atomic status transitions, idempotent request/retry), the Milestone 6 `notification-deliveries.ts` repository (idempotent request/retry via a real database unique constraint, atomic conditional status transitions, journal events emitted alongside each), `closeJournalTrade`'s server-side MFE/MAE and `outcome` computation, and the `getNormalizedTrades()` backtest↔journal analytics adapter.
- **packages/screenshot-storage** (Milestone 5) — the `ScreenshotStorage` interface (`save`/`read`/`exists`/`delete`) plus `LocalDiskScreenshotStorage`, its only implementation today, and `buildScreenshotStorageKey` (a path-traversal-safe key generator over our own database-issued UUIDs). No database, no HTTP. Depends on nothing else in this monorepo; both `apps/worker` and `apps/api` register their own provider instance against it (see `docs/screenshot-design.md`).

## Dependency direction

```
apps/api, apps/worker, apps/dashboard
        │
        ▼
packages/database ──▶ packages/trading-domain ──▶ packages/shared-types
packages/analytics ─▶ packages/trading-domain
packages/backtester ─▶ packages/strategy-engine ─▶ packages/trading-domain
                    └─▶ packages/risk-engine ─────▶ packages/trading-domain
apps/worker, apps/api ─▶ packages/screenshot-storage
```

`packages/screenshot-storage` depends on nothing else in this monorepo (not even `packages/shared-types`); only `apps/worker` (to write a captured PNG) and `apps/api` (to serve one back, and to health-check the storage backend) depend on it.

Packages never depend on apps. `strategy-engine`, `risk-engine`, `backtester`, and `analytics` never depend on `database`, NestJS, or Next.js — they are pure domain logic, independently testable and reusable from a future research worker (e.g. Python) if ever needed. `packages/database` and `packages/analytics` share no dependency on each other — both depend only on `trading-domain`'s `NormalizedTrade` type (`database` produces it via `getNormalizedTrades()`, `analytics` only ever consumes it); `apps/api` is the only place that imports both.

## Source of truth

PostgreSQL is the only persistent source of truth. Redis is ephemeral queue/cache/pub-sub infrastructure (BullMQ job state, plus the Milestone 3 realtime notification channel: `packages/shared-types`' `REALTIME_CHANNEL`); nothing that must survive a `FLUSHALL` lives only in Redis. A dropped or missed pub/sub message is never a correctness problem: the dashboard's `/live-setups` page reloads from the REST API on reconnect rather than trusting it saw every message. Nothing depends on LLM memory for historical facts; runtime AI agents (future milestones) query PostgreSQL through the domain packages.

## Where financial logic is allowed to live

Only in `packages/risk-engine`, `packages/strategy-engine`, `packages/backtester`, and `packages/analytics`. It must never appear in:

- NestJS controllers (they validate input and call a domain package/service)
- React/Next.js components (they render already-computed values)
- AI prompts (AI explains numbers; it never produces them)
- Persistence adapters (Prisma mappers convert types; they do not compute financial values)

## Reproducibility and auditability

- `StrategyVersion` rows are immutable once created. Every change is a new version.
- `runBacktest` is a pure function: identical inputs (candles, strategy version, assumptions) always produce identical trades and metrics.
- Every `BacktestTrade` links back to the `StrategyVersion` and `Instrument` that produced it, and every `Backtest` records the assumptions (commission, slippage, risk %) it ran with, so a result can be explained and reproduced later.
- `MarketSnapshot` and `RiskCalculation` rows are immutable once created (no update path exists in `packages/database`); a `Setup` needing fresher context or a recalculation gets a *new* row, never a mutated one.
- Every `Setup`/`RiskCalculation`/`JournalTrade` lifecycle change emits a matching `JournalEvent` in the same database transaction — the event and the change it describes can never disagree. All events for one `Setup`'s lifecycle (including its `JournalTrade`'s) share `correlationId = setup.id`, making timeline reconstruction a single indexed query. See `docs/trade-journal-design.md`.
- A duplicate `InboundWebhookEvent` delivery cannot create a duplicate `Setup`: `fingerprint` carries a database `@unique` constraint, so idempotency is enforced by the database itself, not by an application-level check-then-insert (which would race under concurrent delivery). See `docs/tradingview-setup.md`.
- A `READY` `TradeScreenshot` row is immutable historical evidence: two `@@unique` constraints (`[setupId, type, chartConfigVersion]`, `[tradeId, tradeSource, type, chartConfigVersion]`) make a repeat request idempotent by database constraint, and a rendering-behavior change bumps `chartConfigVersion` into a new row rather than mutating an old one. Every candle a screenshot's chart renders satisfies `timestamp <= cutoff`, where the cutoff is read server-side from a fresh `MarketSnapshot`/`JournalTrade` row (never `new Date()`, never client-supplied) — see `docs/screenshot-design.md`.
- A `NotificationDelivery` is sent at most once per `(setupId, notificationType, templateVersion)`: `@@unique([setupId, notificationType, templateVersion])` is a real database constraint, not a check-then-insert race, mirroring the same idempotency pattern `InboundWebhookEvent.fingerprint` and `TradeScreenshot`'s constraints already use. `JournalTrade.mfe`/`mae`/`outcome` are always computed server-side at `closeJournalTrade` time (`packages/risk-engine`'s `calculateExcursions` over real candles, and `netPnl`'s sign, respectively) - never accepted as client input. See `docs/notifications.md`.
