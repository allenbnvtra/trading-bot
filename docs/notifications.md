# Notifications

Milestone 6 adds outbound notifications for `Setup` lifecycle events, plus the human-driven manual trade workflow (execute/skip) that those notifications exist to support. Nothing in this subsystem places a broker order or sends anything on its own initiative beyond relaying a `Setup`'s own state, and every send goes through a durable, idempotent `NotificationDelivery` row before a message is attempted.

## The `NotificationProvider` abstraction

`apps/worker/src/notifications/notification-provider.ts` defines the interface every provider implements:

```ts
interface NotificationProvider {
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}
```

`NotificationMessage` is `{ text: string; imageBuffer: Buffer | null }`; `NotificationSendResult` is `{ externalMessageId: string | null }`. The same file also defines `NotificationProviderError`, thrown by a provider when a send fails:

```ts
class NotificationProviderError extends Error {
  constructor(message: string, public readonly kind: "TEMPORARY" | "PERMANENT", public readonly failureCode: string) { ... }
}
```

`kind` drives retry behavior (see "Retry, backoff, and failure classification" below). `failureCode` is always drawn from a small, fixed, known set, never raw provider error text, so nothing provider-specific (which could in principle echo request details, including a bot token, back in an error body) ever ends up in a stored `failureMessage`.

Two implementations exist:

- **`ConsoleNotificationProvider`** (`console-notification.provider.ts`): logs a sanitized representation (the message text, plus `[+image, N bytes]` if an image is attached - the image itself is never dumped as binary/base64 into logs) and returns a synthetic `externalMessageId` of the form `console-<n>`. Used for local development with no Telegram credentials, and used exclusively by every automated test that exercises the send pipeline end to end. Tests never talk to the real Telegram provider.
- **`TelegramNotificationProvider`** (`telegram-notification.provider.ts`): talks to the Telegram Bot API over plain `fetch` (no SDK). Uses `sendPhoto` when `imageBuffer` is present, `sendMessage` otherwise. Never logs `config.botToken` and never includes a caught network error's own message in a thrown `NotificationProviderError` (a raw fetch rejection could itself contain the request URL, which embeds the bot token, depending on the runtime).

`apps/worker/src/notifications/notification-provider.factory.ts`'s `createNotificationProvider(env)` picks which one to construct. `NOTIFICATION_MODE` defaults to `"console"` when unset. If it is anything other than `"console"`, the factory additionally requires `TELEGRAM_ENABLED === "true"` and both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to be non-empty before constructing `TelegramNotificationProvider`; any missing or partial piece of that configuration falls back to `ConsoleNotificationProvider` rather than crashing the worker at startup.

## Telegram configuration

Three environment variables, all read only when `NOTIFICATION_MODE=telegram`, and all required together:

- `TELEGRAM_ENABLED` - must be exactly the string `"true"`.
- `TELEGRAM_BOT_TOKEN` - the bot token from BotFather.
- `TELEGRAM_CHAT_ID` - the numeric chat id to send to.

The single check `isTelegramConfigured(env)` (defined once, in `packages/shared-types/src/notifications.ts`, and re-exported from `apps/worker/src/notifications/notification-provider.factory.ts` so every existing import keeps working) is the one implementation of this three-variable check, shared by `apps/worker` (which provider to construct) and `apps/api` (`health.service.ts`, which reports `providerEnabled`). Any one of the three missing or set to anything other than `"true"`/a non-empty string means the real Telegram provider is never constructed, never attempted.

`.env.example`'s current Notifications section (verbatim):

```
# --- Notifications (Milestone 6) ---

# "console" (default, no credentials needed - logs a sanitized
# representation instead of calling Telegram) or "telegram". Automated
# tests always use the console provider directly, regardless of this
# value - see docs/notifications.md.
NOTIFICATION_MODE=console

# A Setup reaching PREPARE is a much noisier, less decision-relevant event
# than READY - off by default to avoid alert spam (mirrors WATCH's
# always-dashboard-only default). Set to "true" to also notify on PREPARE.
NOTIFICATION_PREPARE_ENABLED=false

# Only read when NOTIFICATION_MODE=telegram. All three must be set (and
# TELEGRAM_ENABLED=true) for the real Telegram provider to be used; any
# partial configuration silently falls back to the console provider rather
# than crashing the worker at startup. Never commit real values here.
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Console mode: the safe zero-credential default

`NOTIFICATION_MODE=console` (or the variable left unset entirely) is the default, precisely so a fresh checkout works end to end with an empty `.env` for this subsystem - no bot token, no chat id, nothing external ever contacted. A `NotificationDelivery` row is still created and still moves through its full status lifecycle; only the actual send target differs. `.env.example` ships with `TELEGRAM_ENABLED=false` and both `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` blank, so a plain `cp .env.example .env` never accidentally enables outbound Telegram traffic.

## Notification policy

`apps/api/src/setups/setup.service.ts`'s private `notifyForStatus(setup)` method is the single place this policy is enforced, called from `updateStatus` after every successful `Setup` status transition (wrapped in a `.catch()` so a notification failure never fails the transition it is a side effect of). Read directly from that method:

| `Setup.status` | Notifies? |
|---|---|
| `WATCH` | Never. No branch in `notifyForStatus` handles it at all - the noisiest state, dashboard-only by design. |
| `PREPARE` | Only if `process.env.NOTIFICATION_PREPARE_ENABLED === "true"`. Default is off (the variable is absent from a fresh `.env.example` copy, and `!== "true"` for any other value including unset). |
| `READY` | Always. Unconditional call to `requestNotification(setup.id, "SETUP_READY")`. |
| `INVALIDATED` / `EXPIRED` / `REJECTED` | Only if a `SETUP_PREPARE` or `SETUP_READY` notification previously reached `SENT` for this setup (checked via `notificationDeliveriesRepository.findMostRecentSentNotification(setup.id, ["SETUP_PREPARE", "SETUP_READY"])`). If none was ever `SENT`, no "never mind" notification is sent - a human who was never told about a setup needs no notice that it went away. When one was sent, the matching notice (`SETUP_INVALIDATED` / `SETUP_EXPIRED` / `SETUP_REJECTED`) is requested. |

The rationale is stated directly in `setup.service.ts`'s own doc comment: `PREPARE` is a much noisier, less decision-relevant state than `READY`, and the same "avoid alert spam" reasoning that already applies to `WATCH` applies to it, so an operator must opt in explicitly.

## Idempotency

Two layers enforce that a given notification is sent at most once:

**Database layer.** `NotificationDelivery` carries `@@unique([setupId, notificationType, templateVersion])` in `packages/database/prisma/schema.prisma`. This is a real Postgres unique constraint, not a check-then-insert race - a second `requestOrRetryNotification` call for the same `(setupId, notificationType, templateVersion)` cannot create a second row; the repository catches the resulting `P2002` and re-reads the existing row instead.

**Job-enqueue layer.** `apps/api/src/notifications/notification.service.ts`'s `enqueueNotificationIfNeeded(queue, notificationDeliveryId, logger)` is job-state-aware, mirroring the same pattern used elsewhere in this codebase for screenshot generation and webhook reconciliation. BullMQ's own `jobId` dedup only blocks `queue.add()` while a job is retained under *any* state, including `failed` (this queue does not set `removeOnFail`), so a blind `add()` would permanently no-op once a job has genuinely failed. The function instead:

- Looks up the existing job by `notificationDeliveryId` (used as the BullMQ `jobId`).
- If no job exists, adds one.
- If the existing job's state is `"failed"`, calls `existingJob.retry("failed")` to put it back in the queue.
- If the existing job's state is `"completed"` while the `NotificationDelivery` row is still `QUEUED`, logs a warning and does nothing further (a state this function treats as "indicates a bug elsewhere," never silently re-enqueued).
- If the job is `waiting`/`active`/`delayed`, it is already in flight and nothing further happens.

## Retry, backoff, and failure classification

`NOTIFICATION_QUEUE` is registered in `apps/worker/src/app.module.ts` with `attempts: 5` and `backoff: { type: "exponential", delay: 5_000 }`.

Failures are classified into three outcomes inside `NotificationSendProcessor.process` (`apps/worker/src/notifications/notification-send.processor.ts`):

1. **`NotificationProviderError` with `kind: "PERMANENT"`.** Recorded via `markNotificationFailed` (status `FAILED`) and **not rethrown** - the job completes rather than exhausting BullMQ's 5 attempts pointlessly, since a bad bot token or bad chat id will never succeed on retry. `TelegramNotificationProvider`'s `classify(status, description)` maps real Telegram responses to these `failureCode`s:
   - HTTP `401` → `INVALID_BOT_TOKEN` (PERMANENT)
   - HTTP `400` with a "chat not found" description → `INVALID_CHAT_ID` (PERMANENT)
   - HTTP `403` → `PERMISSION_DENIED` (PERMANENT)
   - Any other non-`ok` response → `MALFORMED_REQUEST` (PERMANENT)
2. **`NotificationProviderError` with `kind: "TEMPORARY"`.** Recorded via `markNotificationRetrying` (status `RETRYING`) and rethrown, so BullMQ's own attempts/backoff retries the job. Mapped `failureCode`s:
   - HTTP `429` → `RATE_LIMITED` (TEMPORARY)
   - HTTP `>= 500` → `TELEGRAM_SERVER_ERROR` (TEMPORARY)
   - A caught network/fetch exception → `NETWORK_ERROR` (TEMPORARY)
3. **`SetupContextNotFoundError`** (defined in `notification-send.processor.ts`). Thrown when the `Setup`'s referenced `Instrument`, `Strategy`, `StrategyVersion`, or `MarketSnapshot` no longer resolves - a dangling-foreign-key condition, not a transport failure. This is deterministic: it fails identically on every one of BullMQ's 5 attempts, since retrying changes nothing about what rows exist in Postgres. It is caught separately and routed to `markNotificationFailed` with `failureCode: "SETUP_CONTEXT_NOT_FOUND"`, **not rethrown**. This is a fix made during this milestone: an earlier version of the processor let this kind of failure fall into the generic `RETRYING` + rethrow path. Because `NOTIFICATION_QUEUE` has no reconciliation sweep for exhausted-attempts rows (unlike the webhook-ingestion queue), that earlier behavior would silently strand the row at `RETRYING` forever once BullMQ exhausted its 5 attempts - invisible to `countRecentFailedNotifications`, which only counts `FAILED` rows. Routing it to `FAILED` immediately gives an honest, auditable outcome instead.
4. **Any other, unclassified exception** (for example a dropped database connection). Treated conservatively as retryable: recorded via `markNotificationRetrying` with `failureCode: "UNKNOWN_ERROR"` and rethrown.

A `NotificationDelivery` with no `setupId`, or one whose `setupId` no longer resolves to a `Setup` row, is also recorded `FAILED` with `failureCode: "SETUP_NOT_FOUND"` (not rethrown) before any provider call is attempted.

## Bounded screenshot wait

Only `SETUP_READY` notifications attempt to attach a screenshot. `NotificationSendProcessor.awaitPreTradeScreenshot(setupId)` polls for a `READY` `PRE_TRADE` `TradeScreenshot` before sending. The exact values, from `packages/shared-types/src/notifications.ts`:

```ts
export const NOTIFICATION_SCREENSHOT_WAIT_MS = 8_000;
export const NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS = 500;
```

The processor polls every 500ms, for up to 8000ms total. If a `READY` `PRE_TRADE` screenshot for the setup appears within that window, its bytes are read from storage and attached (`sendPhoto`). If it never appears within the window, or if it is found `READY` but its bytes fail to load from storage, the notification is sent text-only (`imageBuffer: null`). There is no separate "send the image later" message: exactly one `NotificationDelivery` row, one BullMQ job, and one Telegram message is ever produced per `(setupId, notificationType, templateVersion)`, regardless of which branch this wait takes.

## The `notification:test` command

`apps/worker/scripts/notification-test.ts`, run via:

```bash
pnpm --filter @trading-copilot/worker notification:test
```

A safe, local-only development utility, deliberately never exposed over an unauthenticated HTTP endpoint.

- **Unconfigured state** (`isTelegramConfigured()` returns false - any of `TELEGRAM_ENABLED`/`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` missing or not all set): prints exactly this message and exits 0 without attempting a send:
  ```
  Telegram is not configured (TELEGRAM_ENABLED/TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not all set), so there is nothing to send. Set NOTIFICATION_MODE=telegram and all three TELEGRAM_* variables in .env to send a real test message.
  ```
- **Configured state**: constructs a provider via `createNotificationProvider()` and sends a real message:
  ```
  🔧 Trading Copilot notification:test. This is a manual verification message, not a real trade alert.
  ```
  Then prints `Sent. externalMessageId=<id>` using the id returned by the provider. Any thrown error is printed via `console.error("notification:test failed:", ...)` and the process exits with a non-zero code.

## Manual trade workflow (execute / skip)

The notification policy above exists to alert a human that a `Setup` needs a decision; the manual trade workflow is how that decision gets recorded, added alongside notifications in this same milestone.

- **`POST /setups/:id/execute`** (`SetupService.execute`): rejects with `409` unless the `Setup` is `READY`. Guards against a double-submit (double-click, a retried HTTP request): if an `OPEN` `JournalTrade` already exists for this `setupId` (checked via `findOpenJournalTradeBySetupId`), it also rejects with `409` rather than silently creating a second `OPEN` `JournalTrade` - `JournalTrade.setupId` carries no unique database constraint, and `execute()` deliberately never transitions the `Setup`'s own status away from `READY`, so nothing else would have stopped a second call. This check is a plain `findFirst`, not inside a transaction with the subsequent create, so it does not close a true microsecond-level concurrent race, only a double-click/retry; it is judged proportionate because `execute()` is only ever called by a human clicking a dashboard button, not by an automated caller. `plannedStop` falls back to `plannedEntry` when the `Setup`'s own `plannedStop` is `null` (a `TRADINGVIEW`-sourced setup can reach `READY` with only a candidate entry known - see `docs/trade-journal-design.md`), since `JournalTrade.plannedStop` is a required column. `plannedRisk` is sourced from the setup's latest `RiskCalculation` if one exists, `null` otherwise - never fabricated as `0`.
- **`POST /setups/:id/skip`** (`SetupService.skip`): records a deliberate "did not take this trade" decision with `executionMode: "SKIPPED"` and an optional `reason` (see the "Skip workflow" section of `docs/trade-journal-design.md`). This is a trade decision, not a `Setup` lifecycle change - the `Setup`'s own status is left untouched and can still separately expire/invalidate on its own terms.

Both endpoints are validated with Zod DTOs (`executeSetupSchema`/`skipSetupSchema` in `packages/shared-types/src/notifications.ts`) and both are exercised from the dashboard's `/setups/:id` detail page (PAPER TRADE / I ENTERED THIS TRADE / SKIP TRADE actions).

## Posture

This remains a personal, single-user tool. The `/setups/:id/execute` and `/skip` endpoints, and every other internal API route, have no authentication or authorization layer - consistent with the rest of this codebase's documented posture (see `docs/architecture.md` and `README.md`). Nothing here should be read as "production-ready" for multi-user or internet-exposed deployment.
