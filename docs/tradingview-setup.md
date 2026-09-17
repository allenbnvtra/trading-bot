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

The HTTP handler does the minimum possible work before responding: parse, validate the envelope, compute the fingerprint, durably persist the raw event, enqueue the job. Everything else (normalization, instrument/strategy resolution, `Setup` creation, journaling) happens in the BullMQ worker — never AI analysis, screenshot rendering, backtests, or large scans in the request path.

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

- Every price/volume field is a **decimal string**, never a bare number — this project never trusts a wire-format float for anything financial (see `CLAUDE.md`). They're parsed into `Decimal` only once resolved.
- `timeframe` is TradingView's own compact interval code (`"1"`, `"5"`, `"15"`, `"60"`, `"240"`, `"D"`), not this project's internal `Timeframe` string — the worker maps it (`packages/shared-types/src/tradingview.ts`'s `TRADINGVIEW_TIMEFRAME_MAP`). An interval with no mapping is rejected (`UNSUPPORTED_TIMEFRAME`), never guessed.
- `signal` is currently only ever `"SETUP_CANDIDATE"`. Any other value is rejected (`UNSUPPORTED_SIGNAL_TYPE`) rather than silently ignored or guessed at.
- `strategyKey`/`strategyVersion` must exactly match an existing `Strategy`/`StrategyVersion` in the database. There is no "fall back to latest version" behavior, ever — an unmatched pair is rejected (`UNKNOWN_STRATEGY_VERSION`).
- `exchange`/`symbol` must resolve through an explicit `TradingViewInstrumentMapping` row. An instrument is never auto-created from webhook data — an unmapped symbol is rejected (`UNKNOWN_INSTRUMENT`).

### schemaVersion and forward compatibility

`schemaVersion` is required on every payload. Only `1` is understood today. A payload with any other `schemaVersion` is still durably stored (so nothing is silently lost) and marked `UNSUPPORTED` — it never crashes the worker or the HTTP request. This lets a future `schemaVersion: 2` payload format coexist safely once it exists, without breaking older alerts still in flight.

## Idempotency

A duplicate physical delivery of the same underlying TradingView trigger must never create a second `Setup`. This is enforced with a real database constraint, not a "check, then insert" pattern (which races under concurrent delivery):

1. A deterministic SHA-256 fingerprint is computed over `provider, strategyKey, strategyVersion, exchange, symbol, timeframe, signal, direction, barTime` (canonicalized: trimmed and lowercased). Deliberately **excluded**: `firedAt` (wall-clock delivery time — a genuine retry of the same trigger can have a different `firedAt`) and the OHLCV fields (redundant for a true duplicate, and excluding them avoids fragility to harmless formatting differences between deliveries).
2. `InboundWebhookEvent.fingerprint` has a database `@unique` constraint.
3. Inserting a second event with the same fingerprint fails at the database level; the handler catches that failure, looks up the original event, and records a `WEBHOOK_DUPLICATE_DETECTED` journal event against it — no second row, no second `Setup`.

This is safe even when two identical deliveries arrive genuinely concurrently (not just sequentially) — see `packages/database/src/journal.integration.test.ts`'s concurrency test.

## Journal timeline

Every step is journaled via the existing `JournalEvent` architecture (see `docs/trade-journal-design.md`) — there is no separate/competing audit system. Events before a `Setup` exists are correlated on the `InboundWebhookEvent`'s own id; once a `Setup` is created, its own events (`SETUP_CREATED` onward) are correlated on the `Setup`'s id, per the existing Milestone 2 convention. `getFullTradingViewTimeline` merges both groups (via `InboundWebhookEvent.setupId`) into one chronological reconstruction:

```
WEBHOOK_RECEIVED → WEBHOOK_NORMALIZED → SIGNAL_ACCEPTED → SETUP_CREATED → SETUP_APPROVED → ...
```

or, for a rejected delivery:

```
WEBHOOK_RECEIVED → WEBHOOK_REJECTED (failureCode: UNKNOWN_INSTRUMENT | UNKNOWN_STRATEGY_VERSION | ...)
```

## Setup creation

A valid signal creates a `Setup` with `source: "TRADINGVIEW"`, `status: "WATCH"`. `plannedEntry` is the alert bar's close price (a real observed value); `plannedStop`/`plannedTarget1` are left **unset** (`null`) — the alert doesn't carry them, and unknown information stays unknown rather than being fabricated. A `RiskCalculation` (and, with it, a real stop/target-informed position size) can be added later once that information is available — see `POST /setups/:id/risk-calculations` in `docs/trade-journal-design.md`. The state machine is unchanged from Milestone 2 (`WATCH → PREPARE → READY`, `REJECTED`/`INVALIDATED`/`EXPIRED` terminal from any non-terminal state).

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

1. `pnpm infra:up` — start Postgres + Redis.
2. `pnpm dev` — start `apps/api`, `apps/worker`, `apps/dashboard`.
3. `pnpm db:migrate && pnpm db:seed` — the seed creates the `ema-trend-pullback` v1.0.0 strategy, the `GENFUT1` instrument, and a `CME`/`NQ1!` → `GENFUT1` `TradingViewInstrumentMapping`.
4. `curl -i -X POST http://localhost:3001/webhooks/tradingview --data @fixtures/tradingview/valid-long.json` — verify the HTTP response (fast, `202`-style acknowledgement with the `InboundWebhookEvent` id).
5. `curl http://localhost:3001/webhooks/tradingview/events/<id>` — verify the inbound event was stored (`RECEIVED` or later).
6. Wait briefly for the worker to pick up the job, then re-check — verify `processingStatus` reaches `PROCESSED`.
7. `curl http://localhost:3001/setups?source=TRADINGVIEW` — verify exactly one `Setup` was created.
8. `curl http://localhost:3001/setups/<id>/timeline` (or the combined webhook+setup timeline endpoint) — verify the full journal.
9. Open `http://localhost:3000/live-setups` — verify the setup appears live in the dashboard.
10. Re-POST the **same** fixture (or `duplicate.json`) — verify the HTTP response indicates a duplicate and `GET /setups?source=TRADINGVIEW` still shows exactly **one** setup.
11. `curl -X POST ... --data @fixtures/tradingview/malformed.json` — verify a fast, clear `400` rejection.
12. `curl -X POST ... --data @fixtures/tradingview/unknown-instrument.json` — verify the event is stored and `REJECTED` with `failureCode: UNKNOWN_INSTRUMENT`, and no `Setup` is created.

## Configuring a real TradingView alert

1. Add `examples/tradingview/ema-trend-pullback-webhook.pine` as an indicator on a chart (development/testing only — see the file's own header: this is an integration-test fixture, not a recommended strategy, and is not optimized).
2. Create an alert on the "LONG" condition, "Once Per Bar Close", with the webhook URL pointing at your deployed `POST /webhooks/tradingview` endpoint (must be publicly reachable over HTTPS — TradingView cannot reach `localhost`; see `docs/tradingview-security.md` for reverse-proxy/TLS guidance).
3. Repeat for the "SHORT" condition.
4. The alert message is a static JSON template with TradingView placeholders substituted at fire time (`{{exchange}}`, `{{ticker}}`, `{{interval}}`, `{{time}}`, `{{timenow}}`, `{{open}}`, `{{high}}`, `{{low}}`, `{{close}}`, `{{volume}}` — all standard, currently-supported placeholders; nothing invented). LONG and SHORT need separate alert conditions/messages since a single alert can't conditionally emit a different `direction` value.

## Out-of-order delivery

Each distinct signal (identified by its fingerprint, which includes `barTime`) creates its own independent `Setup` — this design never updates an existing `Setup` in place from a later webhook delivery. Consequently, out-of-order HTTP arrival is safe by construction: there is no shared mutable state that an older event could regress. If this ever changes (e.g. a future milestone lets a later signal amend an earlier `Setup`), that logic must compare domain timestamps (`barTime`), never assume HTTP arrival order reflects market-event order.
