# Trade Chart Screenshot Design (Milestone 5, implemented)

Milestone 5 builds a real internal chart renderer, a Playwright capture worker, and object storage for PRE_TRADE / POST_TRADE chart screenshots, on top of the `TradeScreenshot` schema Milestone 2 shipped as metadata-only. This document describes what was actually built. For the original problem statement ("why not just screenshot TradingView") that motivated the design, see the "Why not screenshot a third party" section below — that reasoning did not change.

## Why not just screenshot TradingView

Screenshotting a third-party platform is fragile (layout changes, auth walls, rate limits) and couples the journal to a UI we don't control. Instead, everything is rendered from data already in PostgreSQL:

```
PostgreSQL candles
      ↓
internal chart renderer (apps/dashboard, an internal-only Next.js route)
      ↓
annotated chart (entry, stop, target(s), support/resistance, VWAP, setup/trade status)
      ↓
Playwright screenshot (apps/worker, headless Chromium)
      ↓
PNG
      ↓
packages/screenshot-storage (local disk in development)
      ↓
served back through a controlled apps/api route, shown in the dashboard
```

## Screenshot types and lifecycle

`TradeScreenshot` (`packages/database/prisma/schema.prisma`) has a `ScreenshotStatus` enum: `REQUESTED → GENERATING → READY | FAILED`. A `FAILED` row can be retried, which resets it back to `REQUESTED`. `READY` is a terminal state for that row: nothing in this codebase ever moves a `READY` row back to any other status, and no field on a `READY` row is ever mutated again — it is immutable historical evidence.

- **PRE_TRADE** — one row per `Setup` (`setupId` set, `tradeId`/`tradeSource` null). Requested automatically when a `Setup` transitions to `READY` (`apps/api/src/setups/setup.service.ts`'s `updateStatus`), or manually via `POST /setups/:id/screenshots/pre-trade`.
- **POST_TRADE** — one row per `JournalTrade` (`tradeId`+`tradeSource: "JOURNAL_TRADE"` set, `setupId` null). Requested automatically when a `JournalTrade` closes (`apps/api/src/journal/journal-trade.service.ts`'s `close`), or manually via `POST /journal/trades/:id/screenshots/post-trade`. Skipped entirely (never attempted) for a trade with no `Setup` lineage (`trade.setupId === null`) — there is no `MarketSnapshot` to source a timeframe from, so there is no chart context to render. A manual request against such a trade is rejected with `422 Unprocessable Entity`.

In both cases, generation is a best-effort side effect: a screenshot-subsystem failure never fails the state transition or the trade close it's attached to. The triggering service call is wrapped in `.catch()` and only logged.

### Idempotency as a database guarantee; immutability as a convention

Two `@@unique` constraints on `TradeScreenshot` are what actually enforce idempotency (no duplicate rows for the same target), not application convention:

```prisma
@@unique([setupId, type, chartConfigVersion])
@@unique([tradeId, tradeSource, type, chartConfigVersion])
```

`requestOrRetryScreenshot` (`packages/database/src/repositories/trade-screenshots.ts`) is the idempotency boundary every caller goes through: a repeat request for the same `(setupId | tradeId+tradeSource, type, chartConfigVersion)` returns the existing row (`alreadyInFlight: true`) rather than creating a duplicate. Concurrent first-time requests race a `findFirst` then `create`, but the `@@unique` constraint is the real safety net — the loser's `create` throws `P2002` inside the transaction, and the loser re-reads and returns the winner's committed row instead of erroring or creating a second row. A change to rendering behavior bumps `CHART_CONFIG_VERSION` (`packages/shared-types/src/screenshot.ts`) and gets a brand-new row under the new version; an old row's `chartConfigVersion` is never rewritten.

The `@@unique` constraints only prevent a *second row* from being created for the same target — they say nothing about an `UPDATE` on a row that already exists. Immutability of an already-`READY` row (its `storageKey`, `renderedAt`, `chartConfigVersion` never changing after the fact) is **not** a database-level guarantee here. It holds because no exposed code path ever issues an `UPDATE` against a `READY` row's own fields: the conditional `updateMany` guard described below only ever matches a row whose status is `REQUESTED` or `GENERATING`, so a `READY` row is structurally unreachable by `markScreenshotGenerating`/`markScreenshotReady`/`markScreenshotFailed`. This is the same convention-based pattern `JournalEvent` uses (see `docs/trade-journal-design.md`) — enforced by "no update function is exposed," not by a Postgres trigger, rule, or column-level restriction. A future script or admin tool that called `prisma.tradeScreenshot.update()` directly, bypassing `trade-screenshots.ts`, would not be stopped by the database.

### The atomic-`updateMany` concurrency fix

The three status-transition functions (`markScreenshotGenerating`, `markScreenshotReady`, `markScreenshotFailed`) each use a conditional `updateMany` guarded by both `id` and the expected current `status`, not a read-then-check-then-`update`. This is a real fix for a real bug: under Postgres READ COMMITTED, a read-then-check-then-`update` by id alone lets two racing calls both read the same pre-transition status, both pass the in-application guard, and both commit — the second silently clobbers the first's already-committed row, including clobbering an already-`READY` row back to `FAILED`. `updateMany`'s `WHERE` clause is re-evaluated against the row's actually-committed state at execution time, so only one of two racing conditional updates can ever match and affect the row; the loser's `result.count === 0` throws a typed `ScreenshotStateError` instead of silently corrupting data. This is why `markScreenshotFailed` can never turn an already-`READY` row into `FAILED` even if a stale, straggling job somehow reaches that call after the row is already `READY`.

## The cutoff rule (anti-look-ahead)

`getCandlesUpToTimestamp` (`packages/database/src/repositories/candles.ts`) is the sole SQL enforcement point:

```ts
where: { instrumentId, timeframe, timestamp: { lte: cutoffTimestamp } }
```

Every candle returned satisfies `timestamp <= cutoff`; nothing after the cutoff is ever fetched. Which timestamp is the cutoff differs by screenshot type, and in both cases it is read server-side from a freshly-fetched database row — never `new Date()`, and never a client- or URL-supplied value:

- **PRE_TRADE** — cutoff is `MarketSnapshot.timestamp` (the `Setup`'s actual decision-time snapshot), fetched in `apps/dashboard/src/app/internal/render/setup/[setupId]/page.tsx`.
- **POST_TRADE** — cutoff is `JournalTrade.exitTimestamp` (the trade's actual close time), fetched in `apps/dashboard/src/app/internal/render/trade/[tradeId]/page.tsx`. This is deliberately not "now": a POST_TRADE render months after the trade closed must still show exactly the candles that existed up to the moment the outcome was known, not everything that has happened since.

The PRE_TRADE render route is structurally, not just conventionally, forbidden from seeing outcome data: it imports and calls only `GET /setups/:id`, `GET /market-snapshots/:id`, `GET /setups/:id/risk-calculations/latest`, `GET /instruments/:id`, `GET /strategies/:id` (best-effort, name lookup only), and the cutoff-safe candles endpoint. It never imports `getJournalTrade` or calls any `/journal/trades` endpoint. `apps/dashboard/src/app/internal/render/setup/route-boundaries.test.ts` proves this with static analysis over the route's own source (comment-stripped, so a mention in prose doesn't trigger a false positive) — and proves the guard itself is not vacuous by checking it actually flags an inserted violation, including one written as an absolute URL rather than a relative path.

Both render pages (`page.tsx`) are Next.js `async` Server Components with no `"use client"` directive, so they execute only on the Node.js server; the shared `RenderClient.tsx` client component they render into never imports `@trading-copilot/shared-types` (whose barrel transitively pulls in `node:crypto`, unsafe in a browser bundle) — any shared constant it needs (`CHART_CONFIG_VERSION`, the candle count default) is read once server-side and passed down as a plain prop.

## Render-ready contract

Playwright cannot just wait for the network to go idle — an annotated chart draws asynchronously after the page loads. The contract (`apps/dashboard/src/lib/render-ready.ts`) is a single DOM signal on `document.body.dataset`:

```ts
setRenderReady()             // document.body.dataset.renderState = "ready"
setRenderError(code, message) // document.body.dataset.renderState = "error", plus code/message
```

`RenderClient.tsx` calls exactly one of these exactly once per render: immediately, for a server-side failure (missing `Setup`/`JournalTrade`/`MarketSnapshot`/candles, an unclosed trade); otherwise `ChartRenderer` drives it itself via its own `onReady`/`onError` callbacks once it finishes drawing (or catches a render-phase exception, reported as `RENDER_EXCEPTION`).

## Playwright capture flow

`apps/worker/src/screenshot-generation/screenshot-generation.processor.ts` (`ScreenshotGenerationProcessor`, BullMQ `Processor` on `SCREENSHOT_QUEUE`):

1. Load the `TradeScreenshot` row by id from the job payload. If already `READY`, no-op (idempotent — a job can be replayed without re-rendering).
2. `markScreenshotGenerating`.
3. Get a fresh `Page`+`BrowserContext` from `BrowserManager` (`apps/worker/src/screenshot-generation/browser-manager.ts`) — one long-lived headless Chromium instance shared across jobs in the worker process, launched lazily on first use; each job gets its own context/page.
4. Assert `job.name` matches the job name expected for `screenshot.type` (`JOB_TYPE_MISMATCH` if not) — `screenshot.type`, freshly read from the DB row, is the authoritative source for which render URL to open; `job.name` is only cross-checked against it, never trusted alone, so a misrouted job fails loudly instead of silently opening `/internal/render/setup/null`.
5. Navigate to the matching internal render route (`/internal/render/setup/:setupId` or `/internal/render/trade/:tradeId`) under `DASHBOARD_INTERNAL_BASE_URL`. A navigation failure itself (dashboard down, connection refused) is reported as `NAVIGATION_FAILED`, distinct from a render that started but never signaled — that's `RENDER_TIMEOUT`, raised if `page.waitForFunction` doesn't see `renderState` become `"ready"`/`"error"` within `RENDER_READY_TIMEOUT_MS` (15s).
6. If the page itself signaled an error, fail with that page-reported code/message.
7. `page.screenshot()` (`SCREENSHOT_CAPTURE_FAILED` on failure), save the PNG via `ScreenshotStorage.save()` (`STORAGE_WRITE_FAILED` on failure) at a key built by `buildScreenshotStorageKey`.
8. `markScreenshotReady` with the storage key, dimensions, mime type, and render timestamp.
9. In a `finally`, close the `BrowserContext` (not just the `Page`) — closing only the page does not close the context that owns it (confirmed against the installed Playwright build), and would otherwise leak a context for the life of the worker process on every job.

Every failure path calls `markScreenshotFailed` with the specific failure code before rethrowing, so BullMQ also records the job itself as failed. `SCREENSHOT_QUEUE` is configured with `attempts: 1` — no automatic BullMQ retry storm; recovery is via the reconciliation-style re-enqueue described below.

## chartConfigVersion

`CHART_CONFIG_VERSION` (`packages/shared-types/src/screenshot.ts`, currently `"1.0.0"`) identifies the rendering configuration (layout, dimensions, visible candle count, annotation behavior) a given screenshot was produced under. It is never bumped in place — a rendering-behavior change bumps the constant and lets the next request create a new row under the two `@@unique` constraints above, leaving every prior row's `chartConfigVersion` (and every field on it) untouched. This is the actual mechanism, not just a convention, behind "a READY row is immutable historical evidence."

## Storage

`packages/screenshot-storage` defines the `ScreenshotStorage` interface (`save`/`read`/`exists`/`delete`) and one implementation today, `LocalDiskScreenshotStorage`:

- Writes go to a temp path (`<path>.tmp-<pid>-<timestamp>`) then an atomic `rename`, so a crash mid-write never leaves a partially-written file visible at the real key — `READY` only ever means "a complete, valid image exists."
- Every key is resolved against a configured root directory and checked to still be inside that root after resolution; a key that would escape it throws rather than reading or writing outside the intended tree.
- `buildScreenshotStorageKey` (`packages/screenshot-storage/src/key.ts`) generates keys only from our own database-issued UUIDs and an allowlist-validated `chartConfigVersion`, never from arbitrary caller input directly — every segment is checked against a strict regex before being interpolated into a path, so even an unexpected string can never traverse outside the intended prefix. Layout: `setups/<setupId>/pre-trade/<chartConfigVersion>.png` or `trades/<journal-trade|backtest-trade>/<tradeId>/post-trade/<chartConfigVersion>.png`.

Both `apps/worker` and `apps/api` register their own `ScreenshotStorage` provider (`screenshot-storage.provider.ts` in each app, under the shared `SCREENSHOT_STORAGE_TOKEN`) — they are separate NestJS processes with separate DI containers, so the provider can't be shared as a single instance, but both read the same `SCREENSHOT_STORAGE_ROOT` env var and resolve to the same on-disk root. `apps/api`'s `GET /screenshots/:id/image` (`apps/api/src/screenshots/screenshot.controller.ts`) is the only place bytes are read back: the client supplies only a UUID, and the real storage key always comes from a fresh database read of the `TradeScreenshot` row, never from request input — this route can never be made to serve an arbitrary file, and the storage directory itself is never exposed publicly.

The database stores metadata only, never the image blob: `id`, `setupId`/`tradeId`+`tradeSource`, `type`, `status`, `storageProvider`, `storageKey`, `mimeType`, `width`/`height`, `marketSnapshotId`, `chartConfigVersion`, `renderedAt`, `failureCode`/`failureMessage`, `createdAt`/`updatedAt`.

### Production storage (not built yet)

`ScreenshotStorage` is an interface specifically so a production deployment can swap in an S3-compatible implementation without touching any caller — nothing outside `packages/screenshot-storage` depends on `LocalDiskScreenshotStorage`'s concrete type. That implementation does not exist yet; local disk is the only backend this milestone ships. This mirrors how `docs/tradingview-security.md` separates what's implemented from what production would additionally need.

## Failure codes

Codes actually assigned to a `FAILED` `TradeScreenshot.failureCode`, or reported by a render route's `errorCode` before a screenshot job is even attempted:

| Code | Where it originates | Meaning |
|---|---|---|
| `SETUP_NOT_FOUND` | `render/setup/[setupId]/page.tsx` | The `Setup` id in the render URL doesn't exist |
| `MARKET_SNAPSHOT_NOT_FOUND` | both render routes | The `Setup`'s (or the trade's linked `Setup`'s) `MarketSnapshot` could not be loaded |
| `TRADE_NOT_FOUND` | `render/trade/[tradeId]/page.tsx` | The `JournalTrade` id in the render URL doesn't exist |
| `TRADE_NOT_CLOSED` | `render/trade/[tradeId]/page.tsx` | POST_TRADE requires a `CLOSED` trade with a non-null `exitTimestamp` |
| `NO_CHART_CONTEXT` | `render/trade/[tradeId]/page.tsx` | The trade has no `setupId` at all — a permanent, by-design condition, distinct from `MARKET_SNAPSHOT_NOT_FOUND` |
| `NO_CANDLES` | both render routes | No candles exist at or before the cutoff timestamp |
| `RENDER_EXCEPTION` | `ChartRenderer` (client-side) | The chart component itself threw while drawing |
| `JOB_TYPE_MISMATCH` | `screenshot-generation.processor.ts` | `job.name` doesn't match the job name expected for the row's `type` |
| `NAVIGATION_FAILED` | `screenshot-generation.processor.ts` | `page.goto()` itself failed (dashboard unreachable, connection refused) |
| `RENDER_TIMEOUT` | `screenshot-generation.processor.ts` | No `renderState: "ready"`/`"error"` signal within `RENDER_READY_TIMEOUT_MS` (15s) |
| `SCREENSHOT_CAPTURE_FAILED` | `screenshot-generation.processor.ts` | `page.screenshot()` itself threw |
| `STORAGE_WRITE_FAILED` | `screenshot-generation.processor.ts` | `ScreenshotStorage.save()` threw |
| `UNKNOWN_ERROR` | `screenshot-generation.processor.ts` | Any other uncaught exception during generation |

A render-page error (`SETUP_NOT_FOUND`, `NO_CANDLES`, etc.) reaches `markScreenshotFailed` via the page signaling `renderState: "error"` with that code, which the processor reads via `page.evaluate` and treats exactly like any other in-process failure.

## Stuck-row recovery (reconciliation-style hardening)

Beyond the original design, this milestone added a real fix mirroring the Milestone 3 hardening pass's webhook-reconciliation pattern: `ScreenshotService`'s `requestPreTradeScreenshot`/`requestPostTradeScreenshot` (`apps/api/src/screenshots/screenshot.service.ts`) re-attempt enqueuing whenever `requestOrRetryScreenshot` reports a row still at `REQUESTED` — including a row that was already in flight — via a job-state-aware helper, `enqueueJobIfNeeded`:

- No BullMQ job found for the screenshot id → `queue.add(...)` (the ordinary new-screenshot path).
- Job found in the `failed` state → `job.retry("failed")`, an atomic BullMQ operation. This is the actual bug this fixes: `SCREENSHOT_QUEUE` retains failed jobs (`removeOnFail` is unset), so a blind `add()` with the same deterministic `jobId` would permanently no-op against the stale failed job forever, leaving a retried row stuck `REQUESTED` with no way to actually re-run.
- Job found `completed` → skipped with a warning log; a completed job implies the row should already be `READY`, so this combination means something else is wrong and is surfaced rather than silently worked around.
- Job found `waiting`/`active`/`delayed` → skipped; already in flight.

This closes the case where Redis was down at the moment of the original enqueue (row created, `REQUESTED`, but no job behind it), and the case where a genuine render failure needs a real retry, not just a stale-job no-op.

## Known limitations

- **A row stuck at `GENERATING` has no automatic recovery path.** The re-enqueue logic above only covers a row still at `REQUESTED`; it deliberately does not cover a row stuck at `GENERATING` (for example, the worker process crashed mid-render after `markScreenshotGenerating` but before `markScreenshotReady`/`markScreenshotFailed`). Recovering that case would require a real periodic reconciliation sweep (job-state-aware, not a blind re-`add()`, per the same reasoning `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts` documents for the analogous webhook case), which is out of scope for now. A `GENERATING` row currently requires manual intervention (e.g. a direct DB fix) to unstick.
- **No S3-compatible storage backend exists yet.** `ScreenshotStorage` is designed to be swappable, but only `LocalDiskScreenshotStorage` is implemented. Production deployment needs a second implementation before it can run anywhere without a persistent local disk.

## AI and screenshots

Future AI agents may receive a structured market snapshot **plus** the chart image for visual context. Structured data remains authoritative for any precise value. Computer vision is never asked to estimate exact risk, ticks, contract count, or P&L from pixels — those come from `packages/risk-engine` and `packages/backtester`, deterministically.
