# TradingView Webhook Setup

Milestone 3 connects a real TradingView alert to a live `Setup` in the trade journal, without any automatic order execution. This document covers the pipeline, the payload format, local testing, and how to eventually point a real TradingView alert at a deployed instance. See `docs/tradingview-security.md` for production hardening and `docs/trade-journal-design.md` for how the resulting `Setup`/`JournalEvent` rows fit into the rest of the journal.

## Pipeline

```
TradingView alert
      ↓ HTTPS POST
POST /webhooks/tradingview               (apps/api)
      ↓ basic schema validation + SHA-256 fingerprint
InboundWebhookEvent row (status RECEIVED)  ← durable, before anything else happens
      ↓ BullMQ enqueue                     (fast HTTP response returned here)
PROCESS_TRADINGVIEW_EVENT job              (apps/worker)
      ↓ normalize (TradingView-specific fields → provider-agnostic shape)
      ↓ resolve instrument (TradingViewInstrumentMapping)
      ↓ resolve strategy + version (exact match, never "latest")
      ↓ create MarketSnapshot from the alert's OHLCV bar
      ↓ create Setup (status WATCH, source TRADINGVIEW)
      ↓ journal events at every step
InboundWebhookEvent row (status PROCESSED, setupId set)
      ↓ Redis pub/sub
WebSocket → Next.js dashboard (/live-setups)
```

The HTTP handler does the minimum possible work before responding: parse, validate the envelope, compute the fingerprint, durably persist the raw event, enqueue the job. Everything else (normalization, instrument/strategy resolution, `Setup` creation, journaling) happens in the BullMQ worker. There is never AI analysis, screenshot rendering, backtests, or large scans in the request path.

## Payload format (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "source": "TRADINGVIEW",
  "strategyKey": "ema-trend-pullback",
  "strategyVersion": "1.0.0",
  "exchange": "CME",
  "symbol": "NQ1!",
  "timeframe": "5",
  "signal": "SETUP_CANDIDATE",
  "direction": "LONG",
  "barTime": "2026-09-18T01:30:00.000Z",
  "firedAt": "2026-09-18T01:30:01.000Z",
  "open": "20123.25",
  "high": "20128.50",
  "low": "20120.00",
  "close": "20126.75",
  "volume": "1043",
  "metadata": {}
}
```

Full schema: `packages/shared-types/src/tradingview.ts` (`tradingViewWebhookV1Schema`). Notes:

- Every price/volume field is a **decimal string**, never a bare number. This project never trusts a wire-format float for anything financial (see `CLAUDE.md`). They're parsed into `Decimal` only once resolved.
- `timeframe` is TradingView's own compact interval code (`"1"`, `"5"`, `"15"`, `"60"`, `"240"`, `"D"`), not this project's internal `Timeframe` string. The worker maps it (`packages/shared-types/src/tradingview.ts`'s `TRADINGVIEW_TIMEFRAME_MAP`). An interval with no mapping is rejected (`UNSUPPORTED_TIMEFRAME`), never guessed.
- `signal` is currently only ever `"SETUP_CANDIDATE"`. Any other value is rejected (`UNSUPPORTED_SIGNAL_TYPE`) rather than silently ignored or guessed at.
- `strategyKey`/`strategyVersion` must exactly match an existing `Strategy`/`StrategyVersion` in the database. There is no "fall back to latest version" behavior, ever. An unmatched pair is rejected (`UNKNOWN_STRATEGY_VERSION`).
- `exchange`/`symbol` must resolve through an explicit `TradingViewInstrumentMapping` row. An instrument is never auto-created from webhook data. An unmapped symbol is rejected (`UNKNOWN_INSTRUMENT`).

### schemaVersion and forward compatibility

`schemaVersion` is required on every payload. Only `1` is understood today. A payload with any other `schemaVersion` is still durably stored (so nothing is silently lost) and marked `UNSUPPORTED`. It never crashes the worker or the HTTP request. This lets a future `schemaVersion: 2` payload format coexist safely once it exists, without breaking older alerts still in flight.

## Idempotency

A duplicate physical delivery of the same underlying TradingView trigger must never create a second `Setup`. This is enforced with a real database constraint, not a "check, then insert" pattern (which races under concurrent delivery):

1. A deterministic SHA-256 fingerprint is computed over `provider, strategyKey, strategyVersion, exchange, symbol, timeframe, signal, direction, barTime` (canonicalized: trimmed and lowercased). Deliberately **excluded**: `firedAt` (wall-clock delivery time: a genuine retry of the same trigger can have a different `firedAt`) and the OHLCV fields (redundant for a true duplicate, and excluding them avoids fragility to harmless formatting differences between deliveries).
2. `InboundWebhookEvent.fingerprint` has a database `@unique` constraint.
3. Inserting a second event with the same fingerprint fails at the database level; the handler catches that failure, looks up the original event, and records a `WEBHOOK_DUPLICATE_DETECTED` journal event against it. No second row, no second `Setup`.

This is safe even when two identical deliveries arrive genuinely concurrently (not just sequentially): see `packages/database/src/webhook-ingestion.integration.test.ts`'s concurrency test.

A distinct idempotency requirement is a **retried processing attempt** of the *same* `InboundWebhookEvent` (BullMQ retries on a thrown error or a crashed worker), which must also never create a second `Setup` even though it is not a duplicate delivery. `Setup.sourceWebhookEventId` carries the same kind of database `@unique` constraint as `fingerprint`: before creating a `Setup`, the worker checks whether one already exists for this event id and reuses it if so, so a retry landing after a crash between `Setup` creation and the event being marked `PROCESSED` recovers cleanly instead of creating a duplicate.

Rejections that never reach the worker at all (an envelope that doesn't parse, or a `schemaVersion: 1` payload that fails the strict shape check) are still durably stored, not silently dropped: the caller gets a fast, synchronous `400`, and the event is recorded as `REJECTED`/`MALFORMED_PAYLOAD` using a fallback fingerprint (a hash of the whole raw body, since the real field-based fingerprint needs specific fields to exist and parse) so it stays queryable via `GET /webhooks/tradingview/events`.

## Journal timeline

Every step is journaled via the existing `JournalEvent` architecture (see `docs/trade-journal-design.md`); there is no separate/competing audit system. Events before a `Setup` exists are correlated on the `InboundWebhookEvent`'s own id; once a `Setup` is created, its own events (`SETUP_CREATED` onward) are correlated on the `Setup`'s id, per the existing Milestone 2 convention. `getFullTradingViewTimeline` merges both groups (via `InboundWebhookEvent.setupId`) into one chronological reconstruction:

```
WEBHOOK_RECEIVED → WEBHOOK_NORMALIZED → SETUP_CREATED → SIGNAL_ACCEPTED → SETUP_APPROVED → ...
```

`SIGNAL_ACCEPTED` necessarily comes after `SETUP_CREATED`, not before it: it records the resolved `instrumentId`/`strategyId`/`strategyVersionId` against the `Setup` that resolution just produced, so the `Setup` (and its own `SETUP_CREATED` event) must already exist by the time it's emitted.

Like Milestone 2's documented gap for the `PREPARE` transition (`docs/trade-journal-design.md`'s emission-mapping table), two internal `InboundWebhookEvent` bookkeeping transitions have no dedicated journal event: `RECEIVED → QUEUED` and `QUEUED → PROCESSING`. These are deliberate, not oversights: `WEBHOOK_RECEIVED` already establishes "we got it," and the fixed `JournalEventType` vocabulary has no separate type for either transition. See the inline comments on `markInboundWebhookEventQueued`/`markInboundWebhookEventProcessing` in `packages/database/src/repositories/inbound-webhook-events.ts`.

Or, for a rejected delivery:

```
WEBHOOK_RECEIVED → WEBHOOK_REJECTED (failureCode: UNKNOWN_INSTRUMENT | UNKNOWN_STRATEGY_VERSION | ...)
```

## Setup creation

A valid signal creates a `Setup` with `source: "TRADINGVIEW"`, `status: "WATCH"`. `plannedEntry` is the alert bar's close price (a real observed value); `plannedStop`/`plannedTarget1` are left **unset** (`null`). The alert doesn't carry them, and unknown information stays unknown rather than being fabricated. A `RiskCalculation` (and, with it, a real stop/target-informed position size) can be added later once that information is available; see `POST /setups/:id/risk-calculations` in `docs/trade-journal-design.md`. The state machine is unchanged from Milestone 2 (`WATCH → PREPARE → READY`, `REJECTED`/`INVALIDATED`/`EXPIRED` terminal from any non-terminal state).

## Setup expiration

A TRADINGVIEW-sourced `Setup` is not watched forever. At creation time the worker sets
`expiresAt = barTime + TRADINGVIEW_SETUP_EXPIRY_MINUTES` (env var, default `60`) and
schedules a delayed BullMQ job (`setup-expiration` queue) for that instant. When the
delay elapses, a dedicated processor re-checks the `Setup`:

- If it is already terminal (`REJECTED`, `INVALIDATED`, or `EXPIRED`: a human, or
  another process, already resolved it before the delay elapsed), the job is a no-op.
  A terminal status is never overwritten, including by expiration.
- Otherwise (including `READY`: an unactioned `READY` setup expires exactly like
  `WATCH`/`PREPARE`, since a human didn't take the trade in time), it transitions to
  `EXPIRED` via the same `transitionSetupStatus` state machine Milestone 2 uses, which
  emits the existing `SETUP_EXPIRED` journal event.

## Realtime notifications

apps/worker publishes JSON events to a single Redis pub/sub channel
(`REALTIME_CHANNEL`, `packages/shared-types/src/realtime.ts`) whenever it creates or
expires a `Setup` (`setup.created`, `setup.expired`), and apps/api publishes
`webhook.received` right when a **new** (non-duplicate) `InboundWebhookEvent` is
created. apps/api's WebSocket gateway (`@nestjs/websockets` + socket.io) subscribes to
that same channel and rebroadcasts every parsed event, unchanged, to connected
dashboard clients as a `realtime-event` message. This is a presentation transport
only; PostgreSQL remains the source of truth, and a dashboard client that reconnects
(or never received a message) reloads current state from the REST API rather than
depending on having seen every message (see `docs/architecture.md`).

## Health

`GET /health` (apps/api) reports a `tradingViewIngestion` field derived from the most
recent `InboundWebhookEvent`: `UNKNOWN` if none has ever been received, `DEGRADED` if
the most recent one ended `FAILED`, otherwise `ONLINE`. The endpoint's overall
`status` is `"degraded"` whenever ingestion is `DEGRADED` (never silently `"ok"`),
but a fresh `UNKNOWN` ingestion state (no alerts fired yet) does not by itself
degrade the overall status.

## Admin/inspection endpoints

- `GET /webhooks/tradingview/events`: filterable list (`provider`, `processingStatus`,
  `setupId`, `dateFrom`, `dateTo`), newest first.
- `GET /webhooks/tradingview/events/:id`: a single `InboundWebhookEvent`, 404 if
  unknown.
- `GET /webhooks/tradingview/events/:id/timeline`: the combined webhook + Setup
  journal reconstruction (`getFullTradingViewTimeline`).

## Local testing (no TradingView account needed)

TradingView cannot call `http://localhost` directly, so every fixture below is tested by POSTing straight to the real endpoint yourself:

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed && pnpm dev
```

```bash
curl -i -X POST http://localhost:3001/webhooks/tradingview \
  -H "Content-Type: application/json" \
  --data @fixtures/tradingview/valid-long.json
```

See `fixtures/tradingview/README.md` for the full fixture list (`valid-long.json`, `valid-short.json`, `duplicate.json`, `unknown-instrument.json`, `unknown-strategy.json`, `malformed.json`, `unsupported-schema.json`) and what each one should produce.

## Manual test procedure

1. `pnpm infra:up`: start Postgres + Redis.
2. `pnpm dev`: start `apps/api`, `apps/worker`, `apps/dashboard`.
3. `pnpm db:migrate && pnpm db:seed`: the seed creates the `ema-trend-pullback` v1.0.0 strategy, the `GENFUT1` instrument, and a `CME`/`NQ1!` → `GENFUT1` `TradingViewInstrumentMapping`.
4. `curl -i -X POST http://localhost:3001/webhooks/tradingview --data @fixtures/tradingview/valid-long.json`: verify the HTTP response (fast, `202`-style acknowledgement with the `InboundWebhookEvent` id).
5. `curl http://localhost:3001/webhooks/tradingview/events/<id>`: verify the inbound event was stored (`RECEIVED` or later).
6. Wait briefly for the worker to pick up the job, then re-check: verify `processingStatus` reaches `PROCESSED`.
7. `curl http://localhost:3001/setups?source=TRADINGVIEW`: verify exactly one `Setup` was created.
8. `curl http://localhost:3001/setups/<id>/timeline` (or the combined webhook+setup timeline endpoint): verify the full journal.
9. Open `http://localhost:3000/live-setups`: verify the setup appears live in the dashboard.
10. Re-POST the **same** fixture (or `duplicate.json`): verify the HTTP response indicates a duplicate and `GET /setups?source=TRADINGVIEW` still shows exactly **one** setup.
11. `curl -X POST ... --data @fixtures/tradingview/malformed.json`: verify a fast, clear `400` rejection, then confirm via `GET /webhooks/tradingview/events?processingStatus=REJECTED` that it was still durably recorded with `failureCode: MALFORMED_PAYLOAD`.
12. `curl -X POST ... --data @fixtures/tradingview/unknown-instrument.json`: verify the event is stored and `REJECTED` with `failureCode: UNKNOWN_INSTRUMENT`, and no `Setup` is created.

## Configuring a real TradingView alert

1. Add `examples/tradingview/ema-trend-pullback-webhook.pine` as an indicator on a chart (development/testing only; see the file's own header: this is an integration-test fixture, not a recommended strategy, and is not optimized).
2. Create an alert on the "LONG" condition, "Once Per Bar Close", with the webhook URL pointing at your deployed `POST /webhooks/tradingview` endpoint (must be publicly reachable over HTTPS since TradingView cannot reach `localhost`; see `docs/tradingview-security.md` for reverse-proxy/TLS guidance).
3. Repeat for the "SHORT" condition.
4. The alert message is a static JSON template with TradingView placeholders substituted at fire time (`{{exchange}}`, `{{ticker}}`, `{{interval}}`, `{{time}}`, `{{timenow}}`, `{{open}}`, `{{high}}`, `{{low}}`, `{{close}}`, `{{volume}}`, all standard, currently-supported placeholders; nothing invented). LONG and SHORT need separate alert conditions/messages since a single alert can't conditionally emit a different `direction` value.

## Out-of-order delivery

Each distinct signal (identified by its fingerprint, which includes `barTime`) creates its own independent `Setup`; this design never updates an existing `Setup` in place from a later webhook delivery. Consequently, out-of-order HTTP arrival is safe by construction: there is no shared mutable state that an older event could regress. If this ever changes (e.g. a future milestone lets a later signal amend an earlier `Setup`), that logic must compare domain timestamps (`barTime`), never assume HTTP arrival order reflects market-event order.

## Known limitations

- **Retry policy.** Both the TradingView webhook queue and the setup-expiration queue are configured with `attempts: 3` and exponential backoff (`apps/api/src/webhooks/tradingview-webhook.module.ts`, `apps/worker/src/app.module.ts`), so a transient failure (a momentary Postgres or Redis blip) is retried automatically rather than marking the event `FAILED` permanently on the first attempt. Both processors are written to be safe under retry: `ALREADY_RESOLVED_STATUSES` in `tradingview-webhook.processor.ts` skips reprocessing an event that already reached a terminal outcome, `Setup.sourceWebhookEventId`'s uniqueness (see "Idempotency" above) prevents a retry that lands *between* `Setup` creation and the event being marked `PROCESSED` from creating a second `Setup`, and the terminal-status check in `setup-expiration.processor.ts` prevents a duplicate expiration-job schedule from ever overwriting an already-resolved `Setup`.
- **A narrow crash window between event persistence and enqueue (fixed).** In `tradingview-webhook.service.ts`, the `InboundWebhookEvent` row is created (claiming its fingerprint) before the BullMQ job is enqueued. If the process crashes in that exact window, the row exists but no job was ever queued to process it, and TradingView's retried delivery (same fingerprint) is now recorded as a duplicate rather than actually queued, since the fingerprint is already claimed. This is a narrow, low-likelihood window and never risked a duplicate `Setup`, but it could leave an event stuck at `RECEIVED`/`QUEUED` with nothing left to process it. `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts` now closes this: a BullMQ repeatable job (registered via `Queue.upsertJobScheduler` with a fixed scheduler id, so re-registering it on every worker restart never creates a duplicate schedule) periodically calls `findStaleInboundWebhookEvents` (`packages/database/src/repositories/inbound-webhook-events.ts`) for any `InboundWebhookEvent` still `RECEIVED`/`QUEUED` past `WEBHOOK_RECONCILIATION_STALE_THRESHOLD_MINUTES` and re-enqueues its processing job. Re-enqueuing is safe unconditionally because `TradingViewWebhookProcessor` is already idempotent per event id (`ALREADY_RESOLVED_STATUSES` / `Setup.sourceWebhookEventId`'s uniqueness), so a harmless duplicate attempt on an event that was actually fine is never a correctness problem.
- **`getFullTradingViewTimeline`'s chronological merge has no tiebreaker for two events sharing an identical millisecond timestamp.** It sorts the webhook-side and Setup-side event groups purely by `JournalEvent.timestamp` (`@default(now())`, millisecond precision); `Array.prototype.sort`'s stability happens to preserve the correct order today (the webhook group is concatenated first), but that is incidental, not a guarantee. A monotonic sequence/insertion-order column on `JournalEvent` would make this deterministic regardless of clock precision. Not observed to misfire in practice; worth hardening if it ever does.
