# Roadmap

Trading Copilot is built incrementally. Each milestone must be correct, tested, and reviewed before the next begins. Do not skip ahead.

## Milestone 1 — Historical research/backtesting foundation (complete)

Historical CSV → validated candles → PostgreSQL → instrument → strategy version → deterministic backtester → persisted trades → performance metrics → NestJS API → Next.js research dashboard → individual trade inspection.

No runtime AI agents. No TradingView. No brokerage connectivity. No automatic execution.

## Milestone 2 — Trade journal foundation + deeper analytics (complete)

Market snapshots, the Setup lifecycle (WATCH/PREPARE/READY/REJECTED/INVALIDATED/EXPIRED), persisted risk calculations, journal trades (paper/manual-live/skipped, distinct from Milestone 1's BacktestTrade), an append-only journal event log with full timeline reconstruction, a deterministic cross-cutting analytics engine (grouping + winner/loser comparison) spanning both backtested and real trades, and dashboard pages for all of it (`/journal`, `/trades`, `/analytics`). See `docs/trade-journal-design.md`.

Rejected/skipped setups remain fully queryable, never deleted. `PostTradeAnalysis` and `TradeScreenshot` exist as schema foundations only — nothing auto-populates them yet.

## Milestone 3 — TradingView webhook ingestion + live setup state machine (complete)

`POST /webhooks/tradingview`: durable, idempotent (database-unique-constraint-backed), asynchronous ingestion via BullMQ, validated/versioned payloads, explicit instrument/strategy resolution (never auto-created, never "latest"), realtime dashboard updates over WebSocket (Redis pub/sub between `apps/worker` and `apps/api`), and a `/live-setups` dashboard. See `docs/tradingview-setup.md` and `docs/tradingview-security.md`.

The WATCH → PREPARE → READY → INVALIDATED / EXPIRED / REJECTED state machine itself shipped in Milestone 2 and is reused unchanged here; this milestone is what actually drives it from a live, external signal source instead of only backtests/manual test data. Human executes only after receiving information; no automatic execution exists anywhere in this codebase.

*(There is no separate "Milestone 4": its original scope, the live setup state machine, is covered above; later milestone numbers are kept as originally planned rather than renumbered, to avoid a drive-by rename across every doc that cites a milestone number.)*

## Milestone 5 — Chart screenshot generation (complete)

Internal chart renderer over stored candles (`apps/dashboard`'s two internal-only render routes), Playwright screenshot capture (`apps/worker`), PRE_TRADE / POST_TRADE image types, a `TradeScreenshot` lifecycle (`REQUESTED`/`GENERATING`/`READY`/`FAILED`) that is idempotent by database constraint and immutable by convention (no exposed update path ever touches a `READY` row, the same pattern `JournalEvent` uses), a dedicated `packages/screenshot-storage` package (local disk today, swappable for S3-compatible storage later), and dashboard screenshot status/thumbnails. See `docs/screenshot-design.md`.

The candle cutoff enforced for every rendered chart (`timestamp <= cutoff`, with the cutoff read server-side from a real `MarketSnapshot`/`JournalTrade` row, never wall-clock time) is the same anti-look-ahead discipline this project applies everywhere else; the PRE_TRADE render route is structurally unable to import or call any journal/trades endpoint.

## Milestone 6 - Notifications + manual trade workflow (complete)

Outbound `Setup`-lifecycle notifications (`WATCH` never notifies, `PREPARE` gated behind `NOTIFICATION_PREPARE_ENABLED` (default off), `READY` always notifies, `INVALIDATED`/`EXPIRED`/`REJECTED` notify only if a prior `PREPARE`/`READY` notification actually reached a human), a `NotificationProvider` abstraction (Telegram, with a zero-credential console fallback so local development never needs real credentials), a durable idempotent `NotificationDelivery` record (database-unique-constraint-backed, one send per setup/notification-type/template-version), retry/backoff with TEMPORARY/PERMANENT failure classification, and a bounded wait to attach a `READY` setup's `PRE_TRADE` screenshot when one is available in time. Alongside it, the manual trade workflow those notifications exist to support: `POST /setups/:id/execute` (PAPER/MANUAL_LIVE, double-submit-guarded) and `POST /setups/:id/skip` (with an optional `SkipReason`), plus server-side-only MFE/MAE (`packages/risk-engine`'s `calculateExcursions` over real candles) and a server-derived `outcome` (`WIN`/`LOSS`/`BREAKEVEN`) at trade close - never client-supplied. See `docs/notifications.md` and the "Skip workflow" section of `docs/trade-journal-design.md`.

*(This milestone's actual scope, drawn forward from what was originally planned as Milestone 9 - "Telegram/notification system" - differs from this roadmap's original Milestone 6 placeholder title, "AI Research Agent." UPDATE: that research-agent scope was subsequently built, as Milestone 7 below, once its turn came up chronologically - the same forward-reference pattern the Milestone 9 entry below uses in the other direction, following this file's own existing precedent for Milestone 3/4.)*

## Milestone 7 - AI Research Agent + Experiment Framework (complete)

Historical journal data → deterministic statistics (`packages/analytics`) → a `ResearchAgent` (LLM, defaulting to a deterministic zero-network `MockAIProvider`) → a schema-validated structured hypothesis → a safe, closed DSL `StrategyDefinition` (never AI-generated code) → the existing deterministic backtester → a staged `RESEARCH → VALIDATION → FINAL_TEST → WALK_FORWARD` experiment pipeline with a database-enforced final-test-reuse safeguard → a human-gated `PAPER_CANDIDATE` `StrategyVersion` status. Full `AgentExecution` audit trail (provider/model/prompt-version/token/cost tracking, including for failed calls), a daily token budget that fails closed on misconfiguration, and dataset-window isolation between stages. See `docs/ai-research.md` and `docs/research-methodology.md`.

The AI never calculates an authoritative P&L/risk number, never modifies an existing `StrategyVersion` in place, and cannot reach `PAPER_TRADING`/`APPROVED` - this milestone stops at `PAPER_CANDIDATE`, requiring an explicit human-confirmed action, with nothing wired to advance further automatically.

*(This reuses the "Milestone 7" number by chronological shipping order - the seventh milestone completed, after 1/2/3/5/6 - matching how the codebase's own migrations/tests/docs already refer to it throughout. The roadmap's original placeholder title for slot 7, "Structure/Regime/Critic/Event agents," has NOT been built and remains future work; it is described in the next section, unnumbered, following this file's own precedent above of not renumbering later placeholders to keep a drive-by rename out of every doc that cites a milestone number.)*

## Next planned milestone - Structure / Regime / Critic / Event agents (not started)

Runtime application agents (not `.claude/agents`) producing structured, audited output. Explicitly not begun as part of Milestone 7 above, per that milestone's own closing instruction: building the AI Research Agent + Experiment Framework does not imply starting live agent work - that decision is made separately, when this milestone is actually taken up.

## Milestone 8 — Winner + Loss Analysis agents

Structured post-trade analysis, hypothesis-only output, never a direct live-strategy mutation.

## Milestone 9 — Telegram/notification system

**Superseded: this scope was built early, as Milestone 6 (see above) rather than in original numeric order.** WATCH/PREPARE/READY/INVALIDATED/EXPIRED notifications with full context; human executes manually. Kept here, unrenumbered, for the same reason Milestone 3/4's note gives: avoiding a drive-by rename across every doc that cites a milestone number. Whatever numeric-order Milestone 9 scope remains once the Structure/Regime/Critic/Event and Winner/Loss Analysis milestones are built will be scoped again at that time - the AI-research-agent-driven notification need this note originally anticipated is now covered by Milestone 7 (see above), which is complete.

## Milestone 10 — Read-only broker/account integration

Read-only only. No order placement, ever.

## Milestone 11 — Walk-forward + paper-trading approval pipeline

Formal research → validation → out-of-sample → walk-forward → paper trading → approval pipeline (see `docs/research-methodology.md`).

*(Milestone 7 built the dataset-role pipeline and stage-advancement foundation this describes - `RESEARCH → VALIDATION → FINAL_TEST → WALK_FORWARD`, with a database-enforced final-test-reuse safeguard and a human-gated `PAPER_CANDIDATE` transition - but explicitly stops there. Outcome-based (pass/fail) promotion criteria, the robustness checks `docs/research-methodology.md`'s "Overfitting and parameter mining" section requires, real paper-trading execution, and the `APPROVED` status remain this milestone's scope, not yet started. See `docs/ai-research.md`'s "Known limitations".)*

## Milestone 12 — 24/7 deployment and monitoring

Single small VPS, Docker Compose, reverse proxy, system health surfaced for every dependency. Fail closed: if required data is unavailable, the system reports `SYSTEM_BLOCKED` rather than guessing.

---

Do not implement everything immediately. Implement each milestone correctly before starting the next.
