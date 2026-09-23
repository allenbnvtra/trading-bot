# Milestone 6 — Notifications + Manual Trade Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop from a `READY` `Setup` to a human decision and back: an auditable, idempotent Telegram (or console-mode) notification carrying a trade card and the PRE_TRADE screenshot, three dashboard actions that let the human record what they actually did (`PAPER TRADE` / `I ENTERED THIS TRADE` / `SKIP TRADE`), a trade-close flow with server-computed P&L/R/MFE/MAE, and the existing Milestone 5 POST_TRADE screenshot trigger firing on close. No automatic broker execution, no runtime AI agents.

**Architecture:** `apps/api` owns the `NotificationDelivery` lifecycle (request/queued/sending/sent/failed/retrying) exactly the way it already owns `TradeScreenshot` — same idempotent-create-via-unique-constraint pattern, same atomic conditional-`updateMany` state transitions, same job-state-aware BullMQ enqueue helper. `apps/worker` owns the actual send: a `NotificationProvider` interface (`TelegramNotificationProvider` / `ConsoleNotificationProvider`) it talks to, and a template-formatting layer that only ever receives already-computed strings — it cannot perform financial arithmetic because it has no access to `decimal.js`-typed inputs, only pre-formatted display strings. Manual trade execution (`PAPER`/`MANUAL_LIVE`/`SKIPPED`) and close reuse Milestone 2's `JournalTrade` model almost entirely as-is; this milestone adds `skipReason`, `outcome`, and moves MFE/MAE from client-supplied input to a server-side calculation over real `Candle` rows, mirroring `packages/backtester`'s own excursion formula via a new pure function in `packages/risk-engine`.

**Tech Stack:** TypeScript, NestJS, Next.js (App Router), Prisma/PostgreSQL, BullMQ/Redis, Zod, decimal.js, Vitest. Telegram Bot API over plain `fetch` (no SDK dependency needed for `sendMessage`/`sendPhoto`).

**Spec:** This plan implements the "MILESTONE 6 GOAL" through "SUCCESS CRITERIA" sections of the Milestone 6 kickoff brief (verbatim spec pasted into this session), cross-referenced against `docs/trade-journal-design.md` (existing `JournalTrade`/`JournalEvent` schema), `docs/screenshot-design.md` (the exact idempotency/job-enqueue patterns this plan mirrors), and `docs/architecture.md` (dependency direction, where financial logic is allowed to live). It assumes Milestone 3 hardening and Milestone 5 are already merged to `main` (they are, as of commit `dbbe00c`).

## Global Constraints

- **Notification idempotency is the highest-priority correctness requirement in this plan**, per the brief. A `NotificationDelivery` row is unique on `(setupId, notificationType, templateVersion)`, enforced by a database constraint — never check-then-insert. Concurrent requests for the same notification must converge on one row and one BullMQ job, mirroring `TradeScreenshot`'s exact pattern in `packages/database/src/repositories/trade-screenshots.ts`.
- Do not trust client-calculated financial values. `grossPnl`/`netPnl`/`rMultiple` are already server-computed (Milestone 2, `computeJournalTradeClose`) — this plan additionally moves `mfe`/`mae` from client input to a server-side calculation over real `Candle` data.
- The notification formatting layer must not calculate financial values. It consumes pre-formatted strings only; `decimal.js` is never imported in `apps/worker/src/notifications/templates/`.
- BullMQ job enqueuing for notifications follows the exact job-state-aware pattern already established for screenshots (`enqueueJobIfNeeded` in `apps/api/src/screenshots/screenshot.service.ts`) and webhook reconciliation (`apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts`): `getJob()` first, branch on state, `job.retry("failed")` for a genuinely failed job, never a blind `add()`.
- Never log a Telegram bot token. Never commit credentials. `NOTIFICATION_MODE=console` must work with zero Telegram configuration, and automated tests must never contact the real Telegram API.
- No automatic broker execution (`buy`/`sell`/`placeOrder`/`cancelOrder`/`modifyOrder`/broker credentials) anywhere in this plan. No runtime AI agents (`ResearchAgent`, `StructureAgent`, etc.), no LLM API calls.
- Strict TypeScript, no `any`. Validate all external input (Zod). Keep controllers thin. PostgreSQL remains the only persistent source of truth; Redis/BullMQ stay ephemeral (`CLAUDE.md`).
- Do not introduce Kubernetes, Kafka, or microservices. Reuse the existing BullMQ/Redis stack.

---

## File Structure

- **Modify** `packages/database/prisma/schema.prisma` — `NotificationDelivery` model, `NotificationProviderType`/`NotificationType`/`NotificationDeliveryStatus` enums, `SkipReason` enum, `JournalTrade.skipReason`/`JournalTrade.outcome` fields, `JournalEventType`/`JournalEntityType` additions.
- **Modify** `packages/trading-domain/src/journal-entities.ts` — `NotificationDelivery` interface, `JournalTrade` interface gains `skipReason`/`outcome`.
- **Modify** `packages/database/src/mappers.ts` — `mapNotificationDelivery`.
- **Create** `packages/shared-types/src/notifications.ts` — `NotificationType`/`NotificationProviderType`/`NotificationDeliveryStatus`/`SkipReason` value arrays, `NOTIFICATION_QUEUE`/job-name constants, `NOTIFICATION_TEMPLATE_VERSION`, request Zod schemas.
- **Modify** `packages/shared-types/src/enums.ts` — `JOURNAL_EVENT_TYPES`/`JOURNAL_ENTITY_TYPES` additions (re-exported from schema, kept in sync — see Task 1).
- **Modify** `packages/shared-types/src/journal.ts` — `createJournalTradeSchema` gains `skipReason`; `closeJournalTradeSchema` loses `mfe`/`mae`; new `executeSetupSchema`, `skipSetupSchema`.
- **Modify** `packages/risk-engine/src/index.ts` — `calculateExcursions` (MFE/MAE).
- **Create** `packages/database/src/repositories/notification-deliveries.ts` — `requestOrRetryNotification`, `markNotificationSending`/`Sent`/`Failed`/`Retrying`, `listNotificationsForSetup`, `findMostRecentSentNotification`, `countRecentFailedNotifications`.
- **Modify** `packages/database/src/repositories/journal-trades.ts` — `createJournalTrade` accepts `skipReason`; `closeJournalTrade` computes `mfe`/`mae` server-side and `outcome`; new `createAndRecordJournalTradeEntry` (atomic create+record-entry for the dashboard's single-action execution flow).
- **Create** `apps/worker/src/notifications/notification-provider.ts` — `NotificationProvider` interface, `NotificationProviderError`.
- **Create** `apps/worker/src/notifications/console-notification.provider.ts`, `telegram-notification.provider.ts`.
- **Create** `apps/worker/src/notifications/notification-provider.factory.ts` — picks the provider from `NOTIFICATION_MODE`/`TELEGRAM_ENABLED`.
- **Create** `apps/worker/src/notifications/templates/ready-trade-card.ts` — pure formatter, no `decimal.js` import.
- **Create** `apps/worker/src/notifications/notification-send.processor.ts` — BullMQ processor: bounded screenshot wait, format, send, mark, journal.
- **Modify** `apps/worker/src/app.module.ts` — register `NOTIFICATION_QUEUE` + new providers.
- **Create** `apps/api/src/notifications/notification.module.ts`, `notification.service.ts`.
- **Modify** `apps/api/src/setups/setup.module.ts`, `setup.service.ts` — trigger notification enqueue per the status policy table.
- **Modify** `apps/api/src/setups/setup.controller.ts` — `POST /setups/:id/execute`, `POST /setups/:id/skip`.
- **Modify** `apps/api/src/journal/journal-trade.controller.ts` — no schema change needed (uses shared-types), but confirm `mfe`/`mae` request fields are gone.
- **Modify** `apps/api/src/health/health.service.ts` — `notification` health block.
- **Create** `apps/worker/scripts/notification-test.ts`, **Modify** `apps/worker/package.json` — `notification:test` script.
- **Modify** `apps/dashboard/src/app/(dashboard)/setups/[id]/page.tsx` — `PAPER TRADE`/`I ENTERED THIS TRADE`/`SKIP TRADE` actions, notification status block.
- **Modify** `apps/dashboard/src/app/(dashboard)/trades/[id]/page.tsx` — `CLOSE TRADE` action (no `mfe`/`mae` inputs), outcome/P&L/R/MFE/MAE display.
- **Modify** `apps/dashboard/src/lib/api.ts` — new client functions for the above.
- **Modify** `.env.example`, `README.md`, `docs/notifications.md` (new), `docs/trade-journal-design.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/implementation-status.md`.

---

## Phase A — Shared contracts (sequential; everything else depends on this landing first)

### Task 1: Schema — NotificationDelivery, SkipReason, JournalTrade.outcome

**Owner:** data-engineer

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/trading-domain/src/journal-entities.ts`
- Modify: `packages/database/src/mappers.ts`
- Test: `packages/database/src/mappers.test.ts`

**Interfaces:**
- Produces: `NotificationProviderType` (`TELEGRAM | CONSOLE`), `NotificationType` (`SETUP_PREPARE | SETUP_READY | SETUP_INVALIDATED | SETUP_EXPIRED | SETUP_REJECTED`), `NotificationDeliveryStatus` (`QUEUED | SENDING | SENT | FAILED | RETRYING`), `SkipReason` (`MISSED_ALERT | PRICE_MOVED | MANUAL_DISAGREEMENT | RISK_TOO_HIGH | BUSY | SETUP_NO_LONGER_VALID | OTHER`) Prisma enums. `NotificationDelivery` Prisma model. `JournalTrade` gains `skipReason SkipReason?` and `outcome PostTradeOutcome?`. `mapNotificationDelivery(row): NotificationDelivery` in `packages/database/src/mappers.ts`.

- [ ] **Step 1: Write the failing mapper test**

```typescript
// packages/database/src/mappers.test.ts — add to the existing file, matching its imports/style
describe("mapNotificationDelivery", () => {
  it("maps every field, including nullable ones, without fabricating defaults", () => {
    const row = {
      id: "notif-1",
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      provider: "TELEGRAM" as const,
      notificationType: "SETUP_READY" as const,
      templateVersion: "1.0.0",
      status: "SENT" as const,
      attemptCount: 1,
      queuedAt: new Date("2026-09-23T00:00:00Z"),
      sendingAt: new Date("2026-09-23T00:00:01Z"),
      sentAt: new Date("2026-09-23T00:00:02Z"),
      externalMessageId: "12345",
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-09-23T00:00:00Z"),
      updatedAt: new Date("2026-09-23T00:00:02Z"),
    };

    expect(mapNotificationDelivery(row)).toEqual({
      id: "notif-1",
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      provider: "TELEGRAM",
      notificationType: "SETUP_READY",
      templateVersion: "1.0.0",
      status: "SENT",
      attemptCount: 1,
      queuedAt: new Date("2026-09-23T00:00:00Z"),
      sendingAt: new Date("2026-09-23T00:00:01Z"),
      sentAt: new Date("2026-09-23T00:00:02Z"),
      externalMessageId: "12345",
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-09-23T00:00:00Z"),
      updatedAt: new Date("2026-09-23T00:00:02Z"),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- mappers`
Expected: FAIL — `mapNotificationDelivery` is not exported.

- [ ] **Step 3: Update the Prisma schema**

Add near the other Milestone 2/5 enums in `packages/database/prisma/schema.prisma`:

```prisma
enum NotificationProviderType {
  TELEGRAM
  CONSOLE
}

// Setup-lifecycle notifications only in this milestone (see
// docs/notifications.md "Notification policy"). tradeId/tradeSource on
// NotificationDelivery are reserved for a future trade-scoped notification
// type (e.g. a fill confirmation) — nothing in this milestone sets them.
enum NotificationType {
  SETUP_PREPARE
  SETUP_READY
  SETUP_INVALIDATED
  SETUP_EXPIRED
  SETUP_REJECTED
}

enum NotificationDeliveryStatus {
  QUEUED
  SENDING
  SENT
  FAILED
  RETRYING
}

// Optional reason recorded when a READY setup is deliberately not taken
// (see docs/notifications.md / docs/trade-journal-design.md "Skip
// workflow"). Nothing auto-assigns this — only a human choosing SKIP TRADE
// on the dashboard sets it, and it is always optional.
enum SkipReason {
  MISSED_ALERT
  PRICE_MOVED
  MANUAL_DISAGREEMENT
  RISK_TOO_HIGH
  BUSY
  SETUP_NO_LONGER_VALID
  OTHER
}
```

Add to `JournalEventType`:

```prisma
  // Milestone 6 — notification delivery lifecycle. See docs/notifications.md.
  NOTIFICATION_QUEUED
  NOTIFICATION_SENDING
  NOTIFICATION_SENT
  NOTIFICATION_RETRYING
  NOTIFICATION_FAILED
```

Add to `JournalEntityType`: `NOTIFICATION_DELIVERY`.

Add fields to `JournalTrade` (near `entryNotes`/`exitNotes`):

```prisma
  // Set only when executionMode is SKIPPED, by a human choosing SKIP TRADE
  // on the dashboard. Always optional — a skip needs no justification to be
  // recorded, but one is preserved for future analysis when given.
  skipReason SkipReason?

  // Computed once, at close time, from the sign of netPnl — never
  // fabricated, never client-supplied. Null until CLOSED. See
  // computeJournalTradeClose in journal-trades.ts.
  outcome PostTradeOutcome?
```

Add the new model (near `TradeScreenshot`, following its exact immutability-documentation convention):

```prisma
// One row per (setupId, notificationType, templateVersion) — the
// @@unique constraint below is the actual idempotency guarantee (a
// database constraint, not check-then-insert), the same pattern
// TradeScreenshot and InboundWebhookEvent already use. A BullMQ retry, or
// two concurrent requests for the same setup reaching READY twice, must
// converge on this one row rather than sending a duplicate Telegram
// message — see requestOrRetryNotification in
// notification-deliveries.ts. tradeId/tradeSource exist for a future
// trade-scoped notification type; every row this milestone creates has
// them null and setupId set.
model NotificationDelivery {
  id String @id @default(uuid())

  setupId String?
  setup   Setup?  @relation(fields: [setupId], references: [id])

  tradeId     String?
  tradeSource TradeSource?

  provider         NotificationProviderType
  notificationType NotificationType
  templateVersion  String

  status       NotificationDeliveryStatus @default(QUEUED)
  attemptCount Int                        @default(0)

  queuedAt  DateTime  @default(now())
  sendingAt DateTime?
  sentAt    DateTime?

  externalMessageId String?

  failureCode    String?
  failureMessage String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([setupId, notificationType, templateVersion])
  @@index([setupId])
  @@index([status, updatedAt])
  @@index([status, sentAt])
}
```

Add `notifications NotificationDelivery[]` to the `Setup` model's relations block.

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm --filter @trading-copilot/database exec prisma migrate dev --name add_notifications_and_trade_outcome`
Expected: a new migration directory under `packages/database/prisma/migrations/`, applied cleanly against the local dev database.

- [ ] **Step 5: Add `mapNotificationDelivery` to `packages/database/src/mappers.ts`**

Follow `mapTradeScreenshot`'s exact style (plain field-for-field mapping, `Decimal` fields — there are none here — converted via `new Decimal(x.toString())`, everything else passed through):

```typescript
export function mapNotificationDelivery(row: PrismaNotificationDeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    setupId: row.setupId,
    tradeId: row.tradeId,
    tradeSource: row.tradeSource,
    provider: row.provider,
    notificationType: row.notificationType,
    templateVersion: row.templateVersion,
    status: row.status,
    attemptCount: row.attemptCount,
    queuedAt: row.queuedAt,
    sendingAt: row.sendingAt,
    sentAt: row.sentAt,
    externalMessageId: row.externalMessageId,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

Define `PrismaNotificationDeliveryRow` as a type alias over `Prisma.NotificationDeliveryGetPayload<{}>` (mirror `PrismaTradeScreenshotRow`'s exact declaration style in the same file — read it first).

- [ ] **Step 6: Add the `NotificationDelivery` interface to `packages/trading-domain/src/journal-entities.ts`**

```typescript
export interface NotificationDelivery {
  id: string;
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  provider: NotificationProviderType;
  notificationType: NotificationType;
  templateVersion: string;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  queuedAt: Date;
  sendingAt: Date | null;
  sentAt: Date | null;
  externalMessageId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Add `skipReason: SkipReason | null;` and `outcome: PostTradeOutcome | null;` to the existing `JournalTrade` interface in the same file. Import the new types from `@trading-copilot/shared-types` (added in Task 2 — this file will not typecheck until Task 2 lands; that is expected and fine within this task's own commit since Task 2 is the very next task in this same phase).

- [ ] **Step 7: Run the mapper test again**

Run: `pnpm --filter @trading-copilot/database test -- mappers`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/database/prisma packages/database/src/mappers.ts packages/database/src/mappers.test.ts packages/trading-domain/src/journal-entities.ts
git commit -m "Milestone 6: add NotificationDelivery schema, SkipReason, JournalTrade.outcome"
```

---

### Task 2: shared-types — notification constants, Zod schemas, enum arrays

**Owner:** data-engineer (continues directly from Task 1 — same schema surface)

**Files:**
- Create: `packages/shared-types/src/notifications.ts`
- Modify: `packages/shared-types/src/enums.ts`
- Modify: `packages/shared-types/src/journal.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/notifications.test.ts`

**Interfaces:**
- Consumes: the Prisma enums from Task 1 (value sets must match exactly — this is the TypeScript mirror the way `screenshot.ts` mirrors `ScreenshotType`/`ScreenshotStatus`).
- Produces: `NOTIFICATION_TYPES`, `NOTIFICATION_PROVIDER_TYPES`, `NOTIFICATION_DELIVERY_STATUSES`, `SKIP_REASONS` value arrays + types; `NOTIFICATION_QUEUE`, `SEND_NOTIFICATION_JOB`, `NOTIFICATION_TEMPLATE_VERSION` constants; `executeSetupSchema`, `skipSetupSchema` Zod schemas + inferred types; `closeJournalTradeSchema` with `mfe`/`mae` removed; `createJournalTradeSchema` with `skipReason` added.

- [ ] **Step 1: Write the failing schema test**

```typescript
// packages/shared-types/src/notifications.test.ts
import { describe, expect, it } from "vitest";
import { executeSetupSchema, skipSetupSchema } from "./notifications";

describe("executeSetupSchema", () => {
  it("accepts a full MANUAL_LIVE execution", () => {
    const result = executeSetupSchema.safeParse({
      executionMode: "MANUAL_LIVE",
      actualEntry: "21425.25",
      quantity: 1,
      entryTimestamp: "2026-09-23T10:00:00.000Z",
      actualFees: "4.50",
      actualSlippage: "0.25",
      notes: "filled a tick worse than planned",
    });
    expect(result.success).toBe(true);
  });

  it("rejects BACKTEST as an execution mode", () => {
    const result = executeSetupSchema.safeParse({
      executionMode: "BACKTEST",
      actualEntry: "21425.25",
      quantity: 1,
      entryTimestamp: "2026-09-23T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("skipSetupSchema", () => {
  it("accepts no reason at all", () => {
    expect(skipSetupSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a known reason", () => {
    expect(skipSetupSchema.safeParse({ reason: "PRICE_MOVED" }).success).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(skipSetupSchema.safeParse({ reason: "BAD_VIBES" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/shared-types test -- notifications`
Expected: FAIL — module not found.

- [ ] **Step 3: Add enum arrays to `packages/shared-types/src/enums.ts`**

```typescript
/**
 * Milestone 6 — which Setup-lifecycle transitions can carry a Telegram (or
 * console-mode) notification. See docs/notifications.md "Notification
 * policy" for the default policy table (WATCH never notifies).
 */
export const NOTIFICATION_TYPES = [
  "SETUP_PREPARE",
  "SETUP_READY",
  "SETUP_INVALIDATED",
  "SETUP_EXPIRED",
  "SETUP_REJECTED",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_PROVIDER_TYPES = ["TELEGRAM", "CONSOLE"] as const;
export type NotificationProviderType = (typeof NOTIFICATION_PROVIDER_TYPES)[number];

/** Mirrors TradeScreenshot's REQUESTED->GENERATING->READY|FAILED shape, with an extra RETRYING state for a bounded-backoff temporary-failure retry in flight. */
export const NOTIFICATION_DELIVERY_STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "RETRYING"] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** Optional reason recorded when a human chooses SKIP TRADE on a READY setup. Never auto-assigned. */
export const SKIP_REASONS = [
  "MISSED_ALERT",
  "PRICE_MOVED",
  "MANUAL_DISAGREEMENT",
  "RISK_TOO_HIGH",
  "BUSY",
  "SETUP_NO_LONGER_VALID",
  "OTHER",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
```

Add `"NOTIFICATION_QUEUED"`, `"NOTIFICATION_SENDING"`, `"NOTIFICATION_SENT"`, `"NOTIFICATION_RETRYING"`, `"NOTIFICATION_FAILED"` to `JOURNAL_EVENT_TYPES`, and `"NOTIFICATION_DELIVERY"` to `JOURNAL_ENTITY_TYPES` — append at the end of each array with a one-line comment, matching the existing "Milestone 5" comment convention for the screenshot additions.

- [ ] **Step 4: Create `packages/shared-types/src/notifications.ts`**

```typescript
import { z } from "zod";
import { EXECUTION_MODES, SKIP_REASONS } from "./enums";

export const NOTIFICATION_QUEUE = "notification-delivery";
export const SEND_NOTIFICATION_JOB = "send-notification";

/** Bumped whenever the READY trade-card's format changes in a way that
 * should not silently rewrite delivery history — mirrors
 * CHART_CONFIG_VERSION's role for screenshots. */
export const NOTIFICATION_TEMPLATE_VERSION = "1.0.0";

/** How long the notification worker waits for a PRE_TRADE screenshot to
 * reach READY before sending a text-only READY notification. See
 * docs/notifications.md "Screenshot attachment". */
export const NOTIFICATION_SCREENSHOT_WAIT_MS = 8_000;
export const NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS = 500;

const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, `${label} must be a plain decimal number string`);

const positiveDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^(?!0(?:\.0+)?$)\d+(\.\d+)?$/, `${label} must be a positive decimal string (not zero)`);

const nonNegativeDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a non-negative decimal string`);

/**
 * The single-action "record what I actually did" endpoint backing the
 * dashboard's PAPER TRADE / I ENTERED THIS TRADE buttons: creates a
 * JournalTrade AND records its entry atomically (see
 * createAndRecordJournalTradeEntry in journal-trades.ts), so the dashboard
 * never has to sequence two API calls for one human action. executionMode
 * is deliberately restricted to PAPER|MANUAL_LIVE — BACKTEST is never
 * created through this path (see createJournalTradeSchema's own comment)
 * and SKIPPED goes through skipSetupSchema/POST /setups/:id/skip instead.
 */
export const executeSetupSchema = z.object({
  executionMode: z.enum(["PAPER", "MANUAL_LIVE"]),
  actualEntry: positiveDecimalString("actualEntry"),
  quantity: z.number().int().positive(),
  entryTimestamp: z.string().datetime(),
  actualFees: nonNegativeDecimalString("actualFees").optional(),
  actualSlippage: nonNegativeDecimalString("actualSlippage").optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type ExecuteSetupInput = z.infer<typeof executeSetupSchema>;

export const skipSetupSchema = z.object({
  reason: z.enum(SKIP_REASONS).optional(),
});
export type SkipSetupInput = z.infer<typeof skipSetupSchema>;

export const notificationListQuerySchema = z.object({
  setupId: z.string().uuid().optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
```

(`decimalString` is unused in this file today but kept for the same reason `journal.ts` keeps its own copy — a future notification-related schema needing a signed decimal. If eslint's `no-unused-vars` flags it, remove it rather than leave a lint failure; do not suppress the rule.)

- [ ] **Step 5: Modify `packages/shared-types/src/journal.ts`**

In `createJournalTradeSchema`, add after `executionMode`:

```typescript
  executionMode: z.enum(["PAPER", "MANUAL_LIVE", "SKIPPED"]),
  skipReason: z.enum(SKIP_REASONS).optional(),
```

(Add `SKIP_REASONS` to the existing `./enums` import at the top of the file.)

In `closeJournalTradeSchema`, delete the `mfe`/`mae` lines entirely:

```typescript
export const closeJournalTradeSchema = z.object({
  actualExit: positiveDecimalString("actualExit"),
  exitTimestamp: z.string().datetime(),
  actualFees: nonNegativeDecimalString("actualFees").optional(),
  actualSlippage: nonNegativeDecimalString("actualSlippage").optional(),
  exitNotes: z.string().trim().max(2000).optional(),
});
```

- [ ] **Step 6: Export the new module from `packages/shared-types/src/index.ts`**

Add `export * from "./notifications";` alongside the existing `export * from "./screenshot";` line.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @trading-copilot/shared-types test`
Expected: PASS, including the new `notifications.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/shared-types
git commit -m "Milestone 6: notification/skip Zod schemas, remove client-supplied mfe/mae"
```

---

### Task 3: packages/risk-engine — calculateExcursions (MFE/MAE)

**Owner:** quant-engineer (parallel with Task 2 — independent file, no dependency on the schema/shared-types work)

**Files:**
- Modify: `packages/risk-engine/src/index.ts`
- Test: `packages/risk-engine/src/index.test.ts` (add to the existing file)

**Interfaces:**
- Produces: `calculateExcursions(candles: ExcursionCandle[], entryPrice: Decimal, direction: Direction): { mfe: Decimal; mae: Decimal }`, `ExcursionCandle` interface (`{ high: Decimal; low: Decimal }`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/risk-engine/src/index.test.ts — add to the existing describe blocks
describe("calculateExcursions", () => {
  it("finds the best/worst unrealized move for a LONG across several candles", () => {
    const entry = new Decimal(100);
    const candles = [
      { high: new Decimal(102), low: new Decimal(99) }, // favorable 2, adverse 1
      { high: new Decimal(105), low: new Decimal(97) }, // favorable 5, adverse 3
      { high: new Decimal(103), low: new Decimal(98) }, // favorable 3, adverse 2
    ];
    const { mfe, mae } = calculateExcursions(candles, entry, "LONG");
    expect(mfe.toString()).toBe("5");
    expect(mae.toString()).toBe("3");
  });

  it("finds the best/worst unrealized move for a SHORT", () => {
    const entry = new Decimal(100);
    const candles = [{ high: new Decimal(103), low: new Decimal(96) }];
    const { mfe, mae } = calculateExcursions(candles, entry, "SHORT");
    expect(mfe.toString()).toBe("4"); // entry(100) - low(96)
    expect(mae.toString()).toBe("3"); // high(103) - entry(100)
  });

  it("never returns a negative excursion even if price never moves favorably/adversely", () => {
    const entry = new Decimal(100);
    const candles = [{ high: new Decimal(100), low: new Decimal(100) }];
    const { mfe, mae } = calculateExcursions(candles, entry, "LONG");
    expect(mfe.toString()).toBe("0");
    expect(mae.toString()).toBe("0");
  });

  it("throws RiskEngineError on an empty candle array", () => {
    expect(() => calculateExcursions([], new Decimal(100), "LONG")).toThrow(RiskEngineError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/risk-engine test -- calculateExcursions`
Expected: FAIL — `calculateExcursions` is not exported.

- [ ] **Step 3: Implement in `packages/risk-engine/src/index.ts`**

Append after `calculateRMultiple`:

```typescript
export interface ExcursionCandle {
  high: Decimal;
  low: Decimal;
}

/**
 * Maximum favorable/adverse excursion across a candle range, in points.
 * Mirrors packages/backtester's engine.ts walkTradeForward loop exactly
 * (same per-candle favorable/adverse formula) so a manually-closed
 * JournalTrade's MFE/MAE is computed identically to a BacktestTrade's,
 * rather than by a second, potentially-diverging implementation. Never
 * negative — a candle range that never moves favorably (or adversely)
 * yields 0 for that side, not a negative number.
 */
export function calculateExcursions(
  candles: ExcursionCandle[],
  entryPrice: Decimal,
  direction: Direction,
): { mfe: Decimal; mae: Decimal } {
  assertFiniteDecimal(entryPrice, "entryPrice");
  if (candles.length === 0) {
    throw new RiskEngineError("candles must not be empty");
  }

  let mfe = new Decimal(0);
  let mae = new Decimal(0);

  for (const candle of candles) {
    assertFiniteDecimal(candle.high, "candle.high");
    assertFiniteDecimal(candle.low, "candle.low");

    const favorable = direction === "LONG" ? candle.high.minus(entryPrice) : entryPrice.minus(candle.low);
    const adverse = direction === "LONG" ? entryPrice.minus(candle.low) : candle.high.minus(entryPrice);

    if (favorable.greaterThan(mfe)) mfe = favorable;
    if (adverse.greaterThan(mae)) mae = adverse;
  }

  return { mfe, mae };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @trading-copilot/risk-engine test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/risk-engine
git commit -m "Milestone 6: add calculateExcursions (server-side MFE/MAE)"
```

---

### Task 4: packages/database — notification-deliveries repository + closeJournalTrade MFE/MAE

**Owner:** data-engineer (sequential — depends on Task 1's schema, Task 2's shared-types, Task 3's `calculateExcursions`)

**Files:**
- Create: `packages/database/src/repositories/notification-deliveries.ts`
- Test: `packages/database/src/repositories/notification-deliveries.test.ts`
- Test: `packages/database/src/notification-idempotency.integration.test.ts` (live Postgres, `describe.skipIf(!process.env.DATABASE_URL)`)
- Modify: `packages/database/src/repositories/journal-trades.ts`
- Test: `packages/database/src/repositories/journal-trades.test.ts` (extend existing file)
- Modify: `packages/database/src/index.ts` — export the new repository

**Interfaces:**
- Consumes: `calculateExcursions` (Task 3), `getCandles` (existing, `packages/database/src/repositories/candles.ts` — unmodified, already supports a `[startDate, endDate]` range query, no new candle-query function needed).
- Produces: `requestOrRetryNotification(input): Promise<{ notification: NotificationDelivery; alreadyInFlight: boolean }>`, `markNotificationSending(id)`, `markNotificationSent(id, input: { externalMessageId: string | null })`, `markNotificationFailed(id, input: { failureCode, failureMessage })`, `markNotificationRetrying(id, input: { failureCode, failureMessage })`, `listNotificationsForSetup(setupId)`, `findMostRecentSentNotification(setupId, notificationTypes: NotificationType[])`, `countRecentFailedNotifications(sinceMinutesAgo)`. `createAndRecordJournalTradeEntry(input): Promise<JournalTrade>` on the journal-trades repository. `closeJournalTrade` signature drops `mfe`/`mae` from its input type.

- [ ] **Step 1: Write the failing idempotency test**

```typescript
// packages/database/src/repositories/notification-deliveries.test.ts
// Follow trade-screenshots.test.ts's exact structure/mocking style — read
// it first. This file uses the mocked prisma client (no live DB); the
// concurrency-under-real-Postgres proof lives in
// notification-idempotency.integration.test.ts (Step 6).

describe("requestOrRetryNotification", () => {
  it("returns the existing row unchanged when one already exists and is not FAILED", async () => {
    // ... mock tx.notificationDelivery.findFirst to return an existing SENT row,
    // assert alreadyInFlight: true and no tx.notificationDelivery.create call.
  });

  it("resets a FAILED row back to QUEUED and clears failureCode/failureMessage", async () => {
    // ... mock an existing FAILED row, assert the update sets status: "QUEUED",
    // failureCode: null, failureMessage: null, and emits a
    // NOTIFICATION_RETRYING-adjacent journal event for the reset (mirror
    // trade-screenshots.ts's SCREENSHOT_RETRIED precedent exactly — call
    // this one's retry event NOTIFICATION_RETRYING, entityType
    // NOTIFICATION_DELIVERY).
  });

  it("re-reads and returns the winner's row on a P2002 unique-constraint race, never throwing", async () => {
    // ... mirror trade-screenshots.test.ts's exact P2002-simulation test.
  });
});

describe("markNotificationSending/Sent/Failed/Retrying", () => {
  it("markNotificationSending only transitions a QUEUED or RETRYING row, guarded by updateMany", async () => {
    // assert the where clause is { id, status: { in: ["QUEUED", "RETRYING"] } }
  });

  it("markNotificationSent throws ScreenshotStateError-equivalent (a new NotificationStateError) if the row is not SENDING", async () => {
    // mock result.count === 0, assert the thrown error and its message
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- notification-deliveries`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/database/src/repositories/notification-deliveries.ts`**

Mirror `trade-screenshots.ts` field-for-field: same `ScreenshotPrismaClientOrTx`-style local transaction type (name it `NotificationPrismaClientOrTx`), same `isUniqueConstraintViolation` helper (or import/reuse the one from `trade-screenshots.ts` if it is exported — check first; if not exported, duplicate the ~10-line helper rather than adding a cross-module dependency between two independent lifecycle repositories), same `findByIdempotencyKey` → `$transaction` → P2002-catch-and-reread structure.

```typescript
import { Prisma } from "@prisma/client";
import type { NotificationProviderType, NotificationType } from "@trading-copilot/shared-types";
import type { NotificationDelivery } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { NotFoundError, NotificationStateError } from "../errors";
import { mapNotificationDelivery } from "../mappers";
import { createJournalEvent } from "./journal-events";

export interface RequestNotificationInput {
  setupId: string;
  provider: NotificationProviderType;
  notificationType: NotificationType;
  templateVersion: string;
}

type NotificationPrismaClientOrTx = Pick<Prisma.TransactionClient, "notificationDelivery">;

function isUniqueConstraintViolation(error: unknown, fields: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    fields.every((field) => (error.meta!.target as unknown[]).includes(field))
  );
}

function findByIdempotencyKey(tx: NotificationPrismaClientOrTx, input: RequestNotificationInput) {
  return tx.notificationDelivery.findFirst({
    where: { setupId: input.setupId, notificationType: input.notificationType, templateVersion: input.templateVersion },
  });
}

/**
 * Idempotent per (setupId, notificationType, templateVersion) — the same
 * "database constraint, not check-then-insert" pattern as
 * TradeScreenshot/InboundWebhookEvent. A pre-existing non-FAILED row is
 * returned as-is. A FAILED row is reset to QUEUED (NOTIFICATION_RETRYING
 * journal event emitted) and returned for reprocessing.
 */
export async function requestOrRetryNotification(
  input: RequestNotificationInput,
): Promise<{ notification: NotificationDelivery; alreadyInFlight: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await findByIdempotencyKey(tx, input);

      if (existing && existing.status !== "FAILED") {
        return { notification: mapNotificationDelivery(existing), alreadyInFlight: true };
      }

      if (existing) {
        const retried = await tx.notificationDelivery.update({
          where: { id: existing.id },
          data: { status: "QUEUED", failureCode: null, failureMessage: null },
        });
        await createJournalEvent(
          {
            eventType: "NOTIFICATION_RETRYING",
            entityType: "NOTIFICATION_DELIVERY",
            entityId: existing.id,
            correlationId: input.setupId,
            metadata: { notificationType: input.notificationType, previousFailureCode: existing.failureCode },
          },
          tx,
        );
        return { notification: mapNotificationDelivery(retried), alreadyInFlight: false };
      }

      const created = await tx.notificationDelivery.create({
        data: {
          setupId: input.setupId,
          provider: input.provider,
          notificationType: input.notificationType,
          templateVersion: input.templateVersion,
          status: "QUEUED",
        },
      });

      await createJournalEvent(
        {
          eventType: "NOTIFICATION_QUEUED",
          entityType: "NOTIFICATION_DELIVERY",
          entityId: created.id,
          correlationId: input.setupId,
          metadata: { notificationType: input.notificationType },
        },
        tx,
      );

      return { notification: mapNotificationDelivery(created), alreadyInFlight: false };
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error, ["setupId", "notificationType", "templateVersion"])) {
      throw error;
    }
    const winner = await findByIdempotencyKey(prisma, input);
    if (!winner) throw error;
    return { notification: mapNotificationDelivery(winner), alreadyInFlight: true };
  }
}

async function requireNotification(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.notificationDelivery.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("NotificationDelivery", id);
  return row;
}

export async function markNotificationSending(id: string): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: { in: ["QUEUED", "RETRYING"] } },
      data: { status: "SENDING", sendingAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark sending", current.status, "QUEUED or RETRYING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_SENDING",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId,
        metadata: { notificationType: row.notificationType, attemptCount: row.attemptCount },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

export interface MarkNotificationSentInput {
  externalMessageId: string | null;
}

export async function markNotificationSent(
  id: string,
  input: MarkNotificationSentInput,
): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "SENT", sentAt: new Date(), externalMessageId: input.externalMessageId },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark sent", current.status, "SENDING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_SENT",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId,
        metadata: { notificationType: row.notificationType },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

export interface MarkNotificationFailedInput {
  failureCode: string;
  failureMessage: string;
}

/** Terminal failure — a permanent-classification provider error (invalid token, invalid chat id). Never auto-retried further. */
export async function markNotificationFailed(
  id: string,
  input: MarkNotificationFailedInput,
): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "FAILED", failureCode: input.failureCode, failureMessage: input.failureMessage },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark failed", current.status, "SENDING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_FAILED",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId,
        metadata: { failureCode: input.failureCode, failureMessage: input.failureMessage },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

/** A temporary-classification provider error with BullMQ attempts remaining — the job will retry, this just records the attempt for the audit trail. */
export async function markNotificationRetrying(
  id: string,
  input: MarkNotificationFailedInput,
): Promise<NotificationDelivery> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.notificationDelivery.updateMany({
      where: { id, status: "SENDING" },
      data: { status: "RETRYING", failureCode: input.failureCode, failureMessage: input.failureMessage },
    });
    if (result.count === 0) {
      const current = await requireNotification(tx, id);
      throw new NotificationStateError("mark retrying", current.status, "SENDING");
    }
    const row = await tx.notificationDelivery.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "NOTIFICATION_RETRYING",
        entityType: "NOTIFICATION_DELIVERY",
        entityId: id,
        correlationId: row.setupId,
        metadata: { failureCode: input.failureCode, failureMessage: input.failureMessage },
      },
      tx,
    );
    return mapNotificationDelivery(row);
  });
}

export async function listNotificationsForSetup(setupId: string): Promise<NotificationDelivery[]> {
  const rows = await prisma.notificationDelivery.findMany({ where: { setupId }, orderBy: { createdAt: "asc" } });
  return rows.map(mapNotificationDelivery);
}

/** Used by the setup-status policy (INVALIDATED/EXPIRED only notify if a PREPARE/READY notification was previously SENT for this setup). */
export async function findMostRecentSentNotification(
  setupId: string,
  notificationTypes: NotificationType[],
): Promise<NotificationDelivery | null> {
  const row = await prisma.notificationDelivery.findFirst({
    where: { setupId, notificationType: { in: notificationTypes }, status: "SENT" },
    orderBy: { sentAt: "desc" },
  });
  return row ? mapNotificationDelivery(row) : null;
}

/** Backs GET /health's notification check — bounded window so a past incident doesn't report DEGRADED forever. Mirrors countRecentFailedScreenshots exactly. */
export async function countRecentFailedNotifications(sinceMinutesAgo: number): Promise<number> {
  const cutoff = new Date(Date.now() - sinceMinutesAgo * 60_000);
  return prisma.notificationDelivery.count({ where: { status: "FAILED", updatedAt: { gte: cutoff } } });
}

export async function findMostRecentSentNotificationOverall(): Promise<NotificationDelivery | null> {
  const row = await prisma.notificationDelivery.findFirst({
    where: { status: "SENT" },
    orderBy: { sentAt: { sort: "desc", nulls: "last" } },
  });
  return row ? mapNotificationDelivery(row) : null;
}
```

Add `NotificationStateError` to `packages/database/src/errors.ts`, mirroring `ScreenshotStateError`'s exact shape (same constructor signature: `operation: string, actualStatus: string, expectedStatus: string`).

- [ ] **Step 4: Run the mocked tests**

Run: `pnpm --filter @trading-copilot/database test -- notification-deliveries`
Expected: PASS.

- [ ] **Step 5: Modify `journal-trades.ts` — server-side MFE/MAE, outcome, skipReason, createAndRecordJournalTradeEntry**

In `createJournalTrade`'s `data` block, add `skipReason: input.skipReason ?? null,`. Update `CreateJournalTradeInput` to include `skipReason: SkipReason | null;`.

In `computeJournalTradeClose`, add an `outcome` field to `ComputedJournalTradeClose` and compute it from `netPnl`'s sign:

```typescript
export interface ComputedJournalTradeClose {
  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  rMultiple: Decimal | null;
  outcome: PostTradeOutcome;
}

export function computeJournalTradeClose(
  direction: Direction,
  actualEntry: Decimal,
  actualExit: Decimal,
  quantity: number,
  pointValue: Decimal,
  fees: Decimal,
  plannedRisk: Decimal | null,
): ComputedJournalTradeClose {
  const grossPnl = calculateGrossPnl(actualEntry, actualExit, quantity, pointValue, direction);
  const netPnl = calculateNetPnl(grossPnl, fees);
  const hasRiskBaseline = plannedRisk !== null && plannedRisk.greaterThan(0);
  const rMultiple = hasRiskBaseline ? calculateRMultiple(netPnl, plannedRisk) : null;
  const outcome: PostTradeOutcome = netPnl.isZero() ? "BREAKEVEN" : netPnl.isPositive() ? "WIN" : "LOSS";
  return { grossPnl, fees, netPnl, rMultiple, outcome };
}
```

In `closeJournalTrade`, remove `input.mfe`/`input.mae` entirely from `CloseJournalTradeInput` (delete those two fields from the interface), and replace the row-update's `mfe`/`mae` source with a server-computed value. Insert, right before the `tx.journalTrade.update` call:

```typescript
    // MFE/MAE, server-computed over real candles between entry and exit —
    // never client-supplied (see docs/notifications.md and CLAUDE.md
    // "financial calculations are never independently produced in a
    // controller"). Only possible when this trade has a Setup lineage (a
    // timeframe to know which candle series to query) — a manually-logged
    // trade with setupId: null legitimately has none, and "unknown stays
    // unknown" (mfe/mae null) rather than a fabricated value or a thrown
    // error blocking the close.
    let mfe: Decimal | null = null;
    let mae: Decimal | null = null;
    if (existing.setupId !== null) {
      const setup = await tx.setup.findUnique({
        where: { id: existing.setupId },
        include: { marketSnapshot: true },
      });
      if (setup) {
        const candles = await getCandles(
          existing.instrumentId,
          setup.marketSnapshot.timeframe as Timeframe,
          existing.entryTimestamp!,
          input.exitTimestamp,
        );
        if (candles.length > 0) {
          const excursions = calculateExcursions(
            candles.map((c) => ({ high: c.high, low: c.low })),
            actualEntry,
            existing.direction,
          );
          mfe = excursions.mfe;
          mae = excursions.mae;
        }
      }
    }
```

Change the `data:` block's `mfe`/`mae` lines to `mfe: mfe?.toString() ?? null,` / `mae: mae?.toString() ?? null,`, and add `outcome,` (a plain enum value, no `.toString()`) alongside `rMultiple`.

`getCandles` (existing, `./candles.ts`) already runs an inclusive `[startDate, endDate]` range query — no new candle-query function is needed. Import it and `calculateExcursions` (from `@trading-copilot/risk-engine`) and `Timeframe` (from `@trading-copilot/shared-types`) at the top of `journal-trades.ts`.

Add `createAndRecordJournalTradeEntry`, the single-action atomic wrapper the dashboard's `PAPER TRADE`/`I ENTERED THIS TRADE` buttons call:

```typescript
export interface CreateAndRecordJournalTradeEntryInput {
  setupId: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  plannedEntry: Decimal;
  plannedStop: Decimal;
  plannedTarget1: Decimal | null;
  plannedTarget2: Decimal | null;
  plannedRisk: Decimal | null;
  executionMode: "PAPER" | "MANUAL_LIVE";
  actualEntry: Decimal;
  quantity: number;
  entryTimestamp: Date;
  actualFees: Decimal | null;
  actualSlippage: Decimal | null;
  notes: string | null;
}

/**
 * Atomically creates a JournalTrade (PLANNED) and immediately records its
 * entry (-> OPEN) in one transaction, for the dashboard's single-action
 * "I ENTERED THIS TRADE"/"PAPER TRADE" buttons — the human is recording one
 * real-world event (a fill that already happened), not two separate
 * journal actions, so the API surface should not force a two-step dance
 * that could be left half-done by a crash between steps.
 */
export async function createAndRecordJournalTradeEntry(
  input: CreateAndRecordJournalTradeEntryInput,
): Promise<JournalTrade> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.journalTrade.create({
      data: {
        setupId: input.setupId,
        instrumentId: input.instrumentId,
        strategyId: input.strategyId,
        strategyVersionId: input.strategyVersionId,
        direction: input.direction,
        plannedEntry: input.plannedEntry.toString(),
        plannedStop: input.plannedStop.toString(),
        plannedTarget1: input.plannedTarget1?.toString() ?? null,
        plannedTarget2: input.plannedTarget2?.toString() ?? null,
        plannedRisk: input.plannedRisk?.toString() ?? null,
        executionMode: input.executionMode,
        status: "OPEN",
        actualEntry: input.actualEntry.toString(),
        entryTimestamp: input.entryTimestamp,
        quantity: input.quantity,
        estimatedFees: input.actualFees?.toString() ?? null,
        estimatedSlippage: input.actualSlippage?.toString() ?? null,
        entryNotes: input.notes ?? null,
      },
    });

    await createJournalEvent(
      {
        eventType: "TRADE_READY",
        entityType: "JOURNAL_TRADE",
        entityId: created.id,
        correlationId: input.setupId,
        instrumentId: created.instrumentId,
        strategyId: created.strategyId,
        strategyVersionId: created.strategyVersionId,
      },
      tx,
    );
    await createJournalEvent(
      {
        eventType: "TRADE_EXECUTED",
        entityType: "JOURNAL_TRADE",
        entityId: created.id,
        correlationId: input.setupId,
        instrumentId: created.instrumentId,
        strategyId: created.strategyId,
        strategyVersionId: created.strategyVersionId,
      },
      tx,
    );

    return mapJournalTrade(created);
  });
}
```

Export `createAndRecordJournalTradeEntry` from `packages/database/src/index.ts` alongside the other `journalTradesRepository` functions (check the existing export style — likely a namespace object `journalTradesRepository = { createJournalTrade, recordJournalTradeEntry, closeJournalTrade, ... }`; add the new function to that same object).

- [ ] **Step 6: Write the live-Postgres concurrency test**

```typescript
// packages/database/src/notification-idempotency.integration.test.ts
// Mirror screenshot-immutability.integration.test.ts's structure exactly:
// describe.skipIf(!process.env.DATABASE_URL), real prisma client, real
// fixtures (instrument/strategy/strategyVersion/marketSnapshot/setup
// created via the existing repositories).

it("10 concurrent requestOrRetryNotification calls for the same (setupId, notificationType, templateVersion) converge on exactly one row", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      notificationDeliveriesRepository.requestOrRetryNotification({
        setupId: setup.id,
        provider: "CONSOLE",
        notificationType: "SETUP_READY",
        templateVersion: "1.0.0",
      }),
    ),
  );
  const ids = new Set(results.map((r) => r.notification.id));
  expect(ids.size).toBe(1);
  const rows = await prisma.notificationDelivery.findMany({
    where: { setupId: setup.id, notificationType: "SETUP_READY" },
  });
  expect(rows).toHaveLength(1);
});

it("a FAILED notification can be retried and reaches SENT without ever creating a second row", async () => {
  const { notification: first } = await notificationDeliveriesRepository.requestOrRetryNotification({ /* ... */ });
  await notificationDeliveriesRepository.markNotificationSending(first.id);
  await notificationDeliveriesRepository.markNotificationFailed(first.id, {
    failureCode: "TEMPORARY_NETWORK_ERROR",
    failureMessage: "connect ETIMEDOUT",
  });
  const { notification: retried, alreadyInFlight } = await notificationDeliveriesRepository.requestOrRetryNotification({ /* same key */ });
  expect(alreadyInFlight).toBe(false);
  expect(retried.id).toBe(first.id);
  expect(retried.status).toBe("QUEUED");
  await notificationDeliveriesRepository.markNotificationSending(retried.id);
  const sent = await notificationDeliveriesRepository.markNotificationSent(retried.id, { externalMessageId: "42" });
  expect(sent.status).toBe("SENT");
  const rows = await prisma.notificationDelivery.findMany({ where: { setupId: setup.id } });
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 7: Extend `journal-trades.test.ts` for server-side MFE/MAE and outcome**

```typescript
describe("computeJournalTradeClose", () => {
  it("computes outcome WIN when netPnl is positive, LOSS when negative, BREAKEVEN when exactly zero", () => {
    // three assertions with entry/exit prices chosen to produce each case,
    // following the existing describe block's exact fixture style.
  });
});
```

Also extend the live-Postgres `journal-trades.integration.test.ts` (or wherever the existing close-flow integration test lives — check first) with a case: close a trade whose `setupId` is set, seed real candles spanning entry→exit including one candle that moves favorably beyond entry and one that moves adversely, assert the closed row's `mfe`/`mae` match `calculateExcursions`'s own output for that exact candle set (a differential proof, not just "some non-null number").

- [ ] **Step 8: Run all database tests**

Run: `pnpm --filter @trading-copilot/database test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/database
git commit -m "Milestone 6: notification-deliveries repository, server-side MFE/MAE, createAndRecordJournalTradeEntry"
```

---

## Phase B — Independent parallel work (all tasks below depend only on Phase A; dispatch in parallel once Phase A is fully merged/integrated)

### Task 5: apps/worker — NotificationProvider abstraction (Console + Telegram)

**Owner:** platform-engineer

**Files:**
- Create: `apps/worker/src/notifications/notification-provider.ts`
- Create: `apps/worker/src/notifications/console-notification.provider.ts`
- Create: `apps/worker/src/notifications/telegram-notification.provider.ts`
- Create: `apps/worker/src/notifications/notification-provider.factory.ts`
- Test: `apps/worker/src/notifications/telegram-notification.provider.test.ts`, `console-notification.provider.test.ts`, `notification-provider.factory.test.ts`

**Interfaces:**
- Produces: `NotificationProvider` interface, `NotificationMessage` (`{ text: string; imageBuffer: Buffer | null }`), `NotificationSendResult` (`{ externalMessageId: string | null }`), `NotificationProviderError` (with `.kind: "TEMPORARY" | "PERMANENT"` and `.failureCode: string`), `createNotificationProvider(): NotificationProvider` factory reading `NOTIFICATION_MODE`/`TELEGRAM_ENABLED`/`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` from `process.env`.

- [ ] **Step 1: Write the failing provider-error classification test**

```typescript
// apps/worker/src/notifications/telegram-notification.provider.test.ts
// Mock global fetch (vi.stubGlobal("fetch", vi.fn())) — never contact the
// real Telegram API in a test.

describe("TelegramNotificationProvider", () => {
  it("sends a text-only message via sendMessage when imageBuffer is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new TelegramNotificationProvider({ botToken: "fake-token", chatId: "123" });

    const result = await provider.send({ text: "hello", imageBuffer: null });

    expect(result.externalMessageId).toBe("42");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.telegram.org/botfake-token/sendMessage"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends a photo with caption via sendPhoto when imageBuffer is present", async () => {
    // assert the URL contains /sendPhoto, not /sendMessage
  });

  it("classifies a 401 Unauthorized response as a PERMANENT NotificationProviderError (invalid bot token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "bad", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "PERMANENT",
      failureCode: "INVALID_BOT_TOKEN",
    });
  });

  it("classifies a 400 'chat not found' response as PERMANENT (invalid chat id)", async () => {
    // status 400, description containing "chat not found" -> failureCode: "INVALID_CHAT_ID"
  });

  it("classifies a 429 Too Many Requests response as TEMPORARY (rate limit)", async () => {
    // status 429 -> kind: "TEMPORARY", failureCode: "RATE_LIMITED"
  });

  it("classifies a network-level fetch rejection (ECONNRESET-style) as TEMPORARY", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET")));
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "TEMPORARY",
      failureCode: "NETWORK_ERROR",
    });
  });

  it("never includes the bot token in a thrown error's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }));
    const provider = new TelegramNotificationProvider({ botToken: "super-secret-token", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.not.toThrow(/super-secret-token/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/worker test -- notification-provider`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `notification-provider.ts`**

```typescript
export interface NotificationMessage {
  text: string;
  imageBuffer: Buffer | null;
}

export interface NotificationSendResult {
  externalMessageId: string | null;
}

export type NotificationFailureKind = "TEMPORARY" | "PERMANENT";

/**
 * TEMPORARY errors are retried by BullMQ's own attempts/backoff (the
 * processor rethrows). PERMANENT errors are not — the processor marks the
 * NotificationDelivery FAILED and returns normally so the job completes
 * without further automatic retries (see notification-send.processor.ts).
 * failureCode is one of a known, stable set (see the Telegram provider's
 * classify function) — never the raw provider error text, which could
 * theoretically embed the bot token in some Telegram error responses.
 */
export class NotificationProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: NotificationFailureKind,
    public readonly failureCode: string,
  ) {
    super(message);
    this.name = "NotificationProviderError";
  }
}

export interface NotificationProvider {
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}
```

- [ ] **Step 4: Implement `console-notification.provider.ts`**

```typescript
import { Logger } from "@nestjs/common";
import type { NotificationMessage, NotificationProvider, NotificationSendResult } from "./notification-provider";

/**
 * NOTIFICATION_MODE=console — logs a sanitized representation (text only;
 * an attached image is noted by byte length, never dumped as binary/base64
 * into logs) and returns a synthetic externalMessageId. Used for local
 * development with no Telegram credentials, and exclusively by every
 * automated test that exercises the send pipeline end-to-end (never the
 * real Telegram provider).
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(ConsoleNotificationProvider.name);
  private counter = 0;

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    this.counter += 1;
    const imageNote = message.imageBuffer ? ` [+image, ${message.imageBuffer.byteLength} bytes]` : "";
    this.logger.log(`[console-notification #${this.counter}] ${message.text}${imageNote}`);
    return { externalMessageId: `console-${this.counter}` };
  }
}
```

- [ ] **Step 5: Implement `telegram-notification.provider.ts`**

```typescript
import { NotificationProviderError, type NotificationMessage, type NotificationProvider, type NotificationSendResult } from "./notification-provider";

export interface TelegramNotificationProviderConfig {
  botToken: string;
  chatId: string;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

/** Never logs config.botToken. Never includes it in a thrown error's message — see the constructor-scoped closure below and the "never includes the bot token" test. */
export class TelegramNotificationProvider implements NotificationProvider {
  constructor(private readonly config: TelegramNotificationProviderConfig) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    const method = message.imageBuffer ? "sendPhoto" : "sendMessage";
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;

    let response: Response;
    try {
      response = await this.doFetch(url, message);
    } catch (error) {
      throw new NotificationProviderError(
        "network error contacting Telegram",
        "TEMPORARY",
        "NETWORK_ERROR",
      );
    }

    const body = (await response.json()) as TelegramApiResponse;

    if (!response.ok || !body.ok) {
      throw this.classify(response.status, body.description ?? "unknown Telegram API error");
    }

    return { externalMessageId: body.result ? String(body.result.message_id) : null };
  }

  private async doFetch(url: string, message: NotificationMessage): Promise<Response> {
    if (message.imageBuffer) {
      const form = new FormData();
      form.set("chat_id", this.config.chatId);
      form.set("caption", message.text);
      form.set("photo", new Blob([message.imageBuffer], { type: "image/png" }), "screenshot.png");
      return fetch(url, { method: "POST", body: form });
    }
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.config.chatId, text: message.text }),
    });
  }

  /** failureCode is always one of a fixed, known set — never raw provider text, so a bot token could never leak through an error's failureCode field even if Telegram ever echoed request details back in an error description. */
  private classify(status: number, description: string): NotificationProviderError {
    if (status === 401) {
      return new NotificationProviderError("Telegram rejected the bot token", "PERMANENT", "INVALID_BOT_TOKEN");
    }
    if (status === 429) {
      return new NotificationProviderError("Telegram rate limit exceeded", "TEMPORARY", "RATE_LIMITED");
    }
    if (status === 400 && /chat not found/i.test(description)) {
      return new NotificationProviderError("Telegram chat id not found", "PERMANENT", "INVALID_CHAT_ID");
    }
    if (status === 403) {
      return new NotificationProviderError("Telegram bot lacks permission to message this chat", "PERMANENT", "PERMISSION_DENIED");
    }
    if (status >= 500) {
      return new NotificationProviderError("Telegram server error", "TEMPORARY", "TELEGRAM_SERVER_ERROR");
    }
    return new NotificationProviderError("Telegram rejected the request", "PERMANENT", "MALFORMED_REQUEST");
  }
}
```

- [ ] **Step 6: Implement `notification-provider.factory.ts`**

```typescript
import { ConsoleNotificationProvider } from "./console-notification.provider";
import type { NotificationProvider } from "./notification-provider";
import { TelegramNotificationProvider } from "./telegram-notification.provider";

/**
 * NOTIFICATION_MODE=console (or unset with no Telegram config) never
 * requires credentials — see docs/notifications.md. NOTIFICATION_MODE
 * defaults to "console" precisely so local development works with a
 * completely empty .env for this subsystem. TELEGRAM_ENABLED must be
 * explicitly "true" AND both TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID must be
 * set for the real provider to be selected — any partial/missing
 * configuration falls back to console mode rather than crashing the
 * worker at startup.
 */
export function createNotificationProvider(env: NodeJS.ProcessEnv = process.env): NotificationProvider {
  const mode = env.NOTIFICATION_MODE ?? "console";
  if (mode === "console") {
    return new ConsoleNotificationProvider();
  }
  const enabled = env.TELEGRAM_ENABLED === "true";
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!enabled || !botToken || !chatId) {
    return new ConsoleNotificationProvider();
  }
  return new TelegramNotificationProvider({ botToken, chatId });
}

export function isTelegramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEGRAM_ENABLED === "true" && Boolean(env.TELEGRAM_BOT_TOKEN) && Boolean(env.TELEGRAM_CHAT_ID);
}
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @trading-copilot/worker test -- notification`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/notifications
git commit -m "Milestone 6: NotificationProvider abstraction (Console + Telegram)"
```

---

### Task 6: apps/worker — ready-trade-card template (pure formatter)

**Owner:** backend-engineer (parallel with Task 5 — independent file)

**Files:**
- Create: `apps/worker/src/notifications/templates/ready-trade-card.ts`
- Test: `apps/worker/src/notifications/templates/ready-trade-card.test.ts`

**Interfaces:**
- Produces: `formatReadyTradeCard(data: ReadyTradeCardData): string`, `ReadyTradeCardData` interface — **every financial field is a pre-formatted `string`, never a `Decimal` or `number`**. This file must never `import Decimal from "decimal.js"` — that is what makes "the formatting layer must not calculate financial values" a structural property of the module, not a review convention.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/notifications/templates/ready-trade-card.test.ts
describe("formatReadyTradeCard", () => {
  it("renders every field when all are present", () => {
    const card = formatReadyTradeCard({
      instrumentSymbol: "NQ",
      direction: "LONG",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      timeframe: "5m",
      entry: "21,425.25",
      stop: "21,409.75",
      target1: "21,456.25",
      target2: "21,487.25",
      stopDistancePoints: "15.5 points",
      riskAmount: "$93",
      quantity: "1 contract",
      riskReward: "2.0R",
      expiresAt: "10:15 ET",
      status: "READY",
    });
    expect(card).toContain("🟢 TRADE READY");
    expect(card).toContain("NQ");
    expect(card).toContain("LONG");
    expect(card).toContain("Opening Pullback v2.4.1");
    expect(card).toContain("21,425.25");
    expect(card).toContain("2.0R");
  });

  it("renders NOT AVAILABLE for a missing target2 rather than fabricating a value", () => {
    const card = formatReadyTradeCard({
      instrumentSymbol: "NQ",
      direction: "LONG",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      timeframe: "5m",
      entry: "21,425.25",
      stop: "21,409.75",
      target1: "21,456.25",
      target2: null,
      stopDistancePoints: "15.5 points",
      riskAmount: "$93",
      quantity: "1 contract",
      riskReward: "2.0R",
      expiresAt: null,
      status: "READY",
    });
    expect(card).toContain("NOT AVAILABLE");
    expect(card).not.toContain("undefined");
    expect(card).not.toContain("null");
  });

  it("renders UNKNOWN for a missing riskReward (no risk calculation exists yet)", () => {
    const card = formatReadyTradeCard({
      instrumentSymbol: "NQ",
      direction: "SHORT",
      strategyName: "Opening Pullback",
      strategyVersion: "2.4.1",
      timeframe: "5m",
      entry: "21,425.25",
      stop: null,
      target1: null,
      target2: null,
      stopDistancePoints: null,
      riskAmount: null,
      quantity: null,
      riskReward: null,
      expiresAt: null,
      status: "READY",
    });
    expect(card).toContain("UNKNOWN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/worker test -- ready-trade-card`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * Every field here is a pre-formatted display string (or null for "not
 * available"), never a Decimal/number — see this file's own absence of any
 * decimal.js import, which is deliberate and load-bearing: it is what
 * makes "the formatting layer must not calculate financial values"
 * enforced by the type system/module graph, not just a review convention.
 * The caller (notification-send.processor.ts) is responsible for every
 * unit of arithmetic, sourced from packages/risk-engine and the
 * already-persisted Setup/RiskCalculation rows.
 */
export interface ReadyTradeCardData {
  instrumentSymbol: string;
  direction: "LONG" | "SHORT";
  strategyName: string;
  strategyVersion: string;
  timeframe: string;
  entry: string;
  stop: string | null;
  target1: string | null;
  target2: string | null;
  stopDistancePoints: string | null;
  riskAmount: string | null;
  quantity: string | null;
  riskReward: string | null;
  expiresAt: string | null;
  status: string;
}

const NOT_AVAILABLE = "NOT AVAILABLE";
const UNKNOWN = "UNKNOWN";

function optionalField(value: string | null, whenMissing: string): string {
  return value ?? whenMissing;
}

export function formatReadyTradeCard(data: ReadyTradeCardData): string {
  const lines = [
    "🟢 TRADE READY",
    "",
    `Instrument: ${data.instrumentSymbol}`,
    `Direction: ${data.direction}`,
    `Strategy: ${data.strategyName} v${data.strategyVersion}`,
    `Timeframe: ${data.timeframe}`,
    `Entry: ${data.entry}`,
    `Stop: ${optionalField(data.stop, NOT_AVAILABLE)}`,
    `Target 1: ${optionalField(data.target1, NOT_AVAILABLE)}`,
    `Target 2: ${optionalField(data.target2, NOT_AVAILABLE)}`,
    `Stop Distance: ${optionalField(data.stopDistancePoints, NOT_AVAILABLE)}`,
    `Risk: ${optionalField(data.riskAmount, UNKNOWN)}`,
    `Quantity: ${optionalField(data.quantity, UNKNOWN)}`,
    `Risk : Reward: ${optionalField(data.riskReward, UNKNOWN)}`,
    `Expires: ${optionalField(data.expiresAt, NOT_AVAILABLE)}`,
    `Status: ${data.status}`,
  ];
  return lines.join("\n");
}
```

Add a similar, smaller `formatSetupStatusNotice(setupId, notificationType, instrumentSymbol, status)` for `PREPARE`/`INVALIDATED`/`EXPIRED`/`REJECTED` notifications (a one- or two-line notice, not the full trade card — e.g. `"⚪ SETUP INVALIDATED\n\nNQ — Opening Pullback v2.4.1"`), in the same file, same no-`decimal.js`-import constraint.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @trading-copilot/worker test -- ready-trade-card`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/notifications/templates
git commit -m "Milestone 6: ready-trade-card formatter (no financial calculation)"
```

---

### Task 7: apps/worker — NotificationSendProcessor + queue registration

**Owner:** backend-engineer (sequential — depends on Task 4's repository, Task 5's provider, Task 6's template)

**Files:**
- Create: `apps/worker/src/notifications/notification-send.processor.ts`
- Modify: `apps/worker/src/app.module.ts`
- Test: `apps/worker/src/notifications/notification-send.processor.test.ts`

**Interfaces:**
- Consumes: `NotificationProvider`/`createNotificationProvider` (Task 5), `formatReadyTradeCard`/`formatSetupStatusNotice` (Task 6), `notificationDeliveriesRepository` (Task 4), `NOTIFICATION_QUEUE`/`SEND_NOTIFICATION_JOB`/`NOTIFICATION_SCREENSHOT_WAIT_MS`/`NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS` (Task 2), `setupsRepository`/`riskCalculationsRepository`/`tradeScreenshotsRepository`/`screenshotStorageProvider`'s `ScreenshotStorage` (all existing).
- Produces: `NotificationSendProcessor` (`@Processor(NOTIFICATION_QUEUE)`), the BullMQ registration in `app.module.ts`.

- [ ] **Step 1: Write the failing bounded-wait test**

```typescript
// apps/worker/src/notifications/notification-send.processor.test.ts
// Mock notificationDeliveriesRepository, setupsRepository,
// riskCalculationsRepository, tradeScreenshotsRepository, and a fake
// NotificationProvider — no real DB/Redis/Telegram.

describe("NotificationSendProcessor", () => {
  it("sends with the PRE_TRADE screenshot attached when it is already READY", async () => {
    // mock tradeScreenshotsRepository.findMostRecentReadyScreenshot-equivalent
    // (a new per-setup lookup, or list+filter) to return a READY row
    // immediately; assert provider.send was called with a non-null
    // imageBuffer and the process took ~0 polling iterations.
  });

  it("sends text-only after the bounded wait elapses with no READY screenshot", async () => {
    // mock the screenshot lookup to always return a non-READY/absent row;
    // use vi.useFakeTimers() and advance past NOTIFICATION_SCREENSHOT_WAIT_MS;
    // assert provider.send was called with imageBuffer: null, and the whole
    // wait took no longer than NOTIFICATION_SCREENSHOT_WAIT_MS.
  });

  it("marks the notification SENT with the provider's externalMessageId on success", async () => { /* ... */ });

  it("on a TEMPORARY provider error, marks the notification RETRYING and rethrows (letting BullMQ retry)", async () => {
    // fake provider.send rejects with NotificationProviderError(kind: "TEMPORARY", ...)
    // assert markNotificationRetrying was called and the processor's promise rejects
  });

  it("on a PERMANENT provider error, marks the notification FAILED and does NOT rethrow (job completes, no further BullMQ retry)", async () => {
    // fake provider.send rejects with NotificationProviderError(kind: "PERMANENT", ...)
    // assert markNotificationFailed was called and the processor's promise resolves
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/worker test -- notification-send`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS,
  NOTIFICATION_SCREENSHOT_WAIT_MS,
  type SendNotificationJobPayload,
} from "@trading-copilot/shared-types";
import {
  notificationDeliveriesRepository,
  riskCalculationsRepository,
  setupsRepository,
  tradeScreenshotsRepository,
} from "@trading-copilot/database";
import type { ScreenshotStorage } from "@trading-copilot/screenshot-storage";
import { NotificationProviderError, type NotificationProvider } from "./notification-provider";
import { formatReadyTradeCard, formatSetupStatusNotice } from "./templates/ready-trade-card";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Processor(NOTIFICATION_QUEUE)
export class NotificationSendProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationSendProcessor.name);

  constructor(
    private readonly provider: NotificationProvider,
    private readonly screenshotStorage: ScreenshotStorage,
  ) {
    super();
  }

  async process(job: Job<SendNotificationJobPayload>): Promise<void> {
    const { notificationDeliveryId } = job.data;
    await notificationDeliveriesRepository.markNotificationSending(notificationDeliveryId);

    const notification = await notificationDeliveriesRepository.getById(notificationDeliveryId);
    const setup = await setupsRepository.getSetup(notification.setupId!);
    if (!setup) {
      // A Setup this notification references no longer resolves - treat as
      // a permanent failure (nothing to retry toward), same convention as
      // ScreenshotGenerationProcessor's JOB_TYPE_MISMATCH guard.
      await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
        failureCode: "SETUP_NOT_FOUND",
        failureMessage: `Setup ${notification.setupId} not found`,
      });
      return;
    }

    const text = await this.formatMessage(notification.notificationType, setup);
    const imageBuffer =
      notification.notificationType === "SETUP_READY" ? await this.awaitPreTradeScreenshot(setup.id) : null;

    try {
      const result = await this.provider.send({ text, imageBuffer });
      await notificationDeliveriesRepository.markNotificationSent(notificationDeliveryId, {
        externalMessageId: result.externalMessageId,
      });
    } catch (error) {
      if (error instanceof NotificationProviderError && error.kind === "PERMANENT") {
        await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
          failureCode: error.failureCode,
          failureMessage: error.message,
        });
        // Deliberately does not rethrow: a PERMANENT failure (bad token,
        // bad chat id) will never succeed on retry, so this job completes
        // rather than exhausting BullMQ's attempts pointlessly - the
        // FAILED row itself, plus a NOTIFICATION_FAILED journal event, is
        // the durable record.
        return;
      }
      const failureCode = error instanceof NotificationProviderError ? error.failureCode : "UNKNOWN_ERROR";
      const failureMessage = error instanceof Error ? error.message : String(error);
      await notificationDeliveriesRepository.markNotificationRetrying(notificationDeliveryId, {
        failureCode,
        failureMessage,
      });
      // Rethrow so BullMQ's attempts/backoff (registered on this queue in
      // app.module.ts) actually retries a TEMPORARY failure.
      throw error;
    }
  }

  /**
   * Bounded wait for a PRE_TRADE screenshot: polls every
   * NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS up to
   * NOTIFICATION_SCREENSHOT_WAIT_MS total. Returns null (text-only
   * notification) on timeout rather than blocking the READY alert
   * indefinitely - see docs/notifications.md "Screenshot attachment".
   * Exactly one NotificationDelivery row/BullMQ job/Telegram message is
   * ever produced per (setupId, notificationType, templateVersion)
   * regardless of which branch this takes - there is no separate
   * "send the image later" message.
   */
  private async awaitPreTradeScreenshot(setupId: string): Promise<Buffer | null> {
    const deadline = Date.now() + NOTIFICATION_SCREENSHOT_WAIT_MS;
    while (Date.now() < deadline) {
      const screenshots = await tradeScreenshotsRepository.listScreenshotsForSetup(setupId);
      const ready = screenshots.find((s) => s.type === "PRE_TRADE" && s.status === "READY");
      if (ready && ready.storageKey) {
        try {
          return await this.screenshotStorage.read(ready.storageKey);
        } catch (error) {
          this.logger.warn(`PRE_TRADE screenshot for Setup ${setupId} is READY but unreadable from storage: ${String(error)}`);
          return null;
        }
      }
      await sleep(NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS);
    }
    this.logger.debug(`PRE_TRADE screenshot for Setup ${setupId} not READY within ${NOTIFICATION_SCREENSHOT_WAIT_MS}ms; sending text-only.`);
    return null;
  }

  private async formatMessage(notificationType: string, setup: Awaited<ReturnType<typeof setupsRepository.getSetup>> & object): Promise<string> {
    if (notificationType !== "SETUP_READY") {
      return formatSetupStatusNotice(notificationType, setup);
    }
    const riskCalculation = await riskCalculationsRepository.getLatestRiskCalculation(setup.id).catch(() => null);
    return formatReadyTradeCard({
      instrumentSymbol: setup.instrument.symbol,
      direction: setup.direction,
      strategyName: setup.strategy.name,
      strategyVersion: setup.strategyVersion.version,
      timeframe: setup.marketSnapshot.timeframe,
      entry: setup.plannedEntry.toFixed(2),
      stop: setup.plannedStop?.toFixed(2) ?? null,
      target1: setup.plannedTarget1?.toFixed(2) ?? null,
      target2: setup.plannedTarget2?.toFixed(2) ?? null,
      stopDistancePoints: riskCalculation ? `${riskCalculation.stopDistancePoints.toFixed(1)} points` : null,
      riskAmount: riskCalculation ? `$${riskCalculation.estimatedTotalRisk.toFixed(0)}` : null,
      quantity: riskCalculation ? `${riskCalculation.calculatedQuantity} contract${riskCalculation.calculatedQuantity === 1 ? "" : "s"}` : null,
      riskReward: riskCalculation ? `${riskCalculation.riskReward.toFixed(1)}R` : null,
      expiresAt: setup.expiresAt ? setup.expiresAt.toISOString() : null,
      status: setup.status,
    });
  }
}
```

(`setup.instrument`/`.strategy`/`.strategyVersion`/`.marketSnapshot` above assume `setupsRepository.getSetup` returns the same relation-included shape `apps/dashboard`'s setup detail page already consumes — verify the exact `Setup` domain type's shape in `packages/trading-domain/src/journal-entities.ts` before writing this and adjust field access accordingly; do not guess at a shape that doesn't match.)

`ScreenshotStorage.read(storageKey)` may not exist yet on the interface — check `packages/screenshot-storage/src/storage.ts` first. If only `save`/`exists` are exposed today, add a `read(key: string): Promise<Buffer>` method to the `ScreenshotStorage` interface and `LocalDiskScreenshotStorage` (a straightforward `fs.readFile` under the same path-containment guard `resolvePath` already provides) as part of this task, with its own test — this is a small, necessary addition, not scope creep, since nothing before this milestone ever needed to read a screenshot's bytes back out from within `apps/worker` itself.

Add a `SendNotificationJobPayload` type (`{ notificationDeliveryId: string }`) to `packages/shared-types/src/notifications.ts` (amend Task 2's file). Add `getById` to `notificationDeliveriesRepository` if not already present from Task 4 (a plain `findUnique` + `mapNotificationDelivery`, mirroring `getScreenshot`).

- [ ] **Step 4: Register in `apps/worker/src/app.module.ts`**

Add the queue registration (mirror `SCREENSHOT_QUEUE`'s block, but WITH retries — this queue needs BullMQ's own backoff for TEMPORARY failures, unlike screenshots' deliberate `attempts: 1`):

```typescript
    BullModule.registerQueue({
      name: NOTIFICATION_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 5_000 },
      },
    }),
```

Add providers: `{ provide: NotificationProvider, useFactory: createNotificationProvider }` (or a plain instantiation — match whichever DI style `screenshotStorageProvider` already uses in this same file) and `NotificationSendProcessor`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @trading-copilot/worker test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker
git commit -m "Milestone 6: NotificationSendProcessor, bounded screenshot wait, queue registration"
```

---

### Task 8: apps/api — NotificationModule/Service + setup status trigger

**Owner:** backend-engineer (sequential — depends on Task 4's repository; independent of Tasks 5-7's worker-side code, so this can run in parallel with those three)

**Files:**
- Create: `apps/api/src/notifications/notification.module.ts`, `notification.service.ts`
- Modify: `apps/api/src/setups/setup.module.ts`, `setup.service.ts`
- Test: `apps/api/src/notifications/notification.service.test.ts`, extend `apps/api/src/setups/setup.service.test.ts`

**Interfaces:**
- Produces: `NotificationService.requestNotification(setupId, notificationType): Promise<void>` (best-effort, mirrors `ScreenshotService`'s enqueue pattern exactly, including `enqueueNotificationIfNeeded` mirroring `enqueueJobIfNeeded`'s job-state-aware logic verbatim).

- [ ] **Step 1: Write the failing policy test**

```typescript
// apps/api/src/setups/setup.service.test.ts — extend the existing file
describe("SetupService.updateStatus notification policy", () => {
  it("does not request a notification when transitioning to WATCH", async () => { /* ... */ });
  it("does not request a SETUP_PREPARE notification by default (NOTIFICATION_PREPARE_ENABLED unset)", async () => { /* ... */ });
  it("requests a SETUP_PREPARE notification when NOTIFICATION_PREPARE_ENABLED=true", async () => {
    // vi.stubEnv("NOTIFICATION_PREPARE_ENABLED", "true"); vi.unstubAllEnvs() in afterEach
  });
  it("requests a SETUP_READY notification when transitioning to READY", async () => { /* ... */ });
  it("requests a SETUP_INVALIDATED notification only if a SETUP_PREPARE or SETUP_READY notification was previously SENT", async () => {
    // mock notificationDeliveriesRepository.findMostRecentSentNotification
    // to return null -> assert requestNotification was NOT called
    // then mock it to return a SENT row -> assert it WAS called
  });
  it("never fails the status transition when notification enqueueing throws", async () => {
    // mock notificationService.requestNotification to reject; assert
    // updateStatus still resolves and returns the transitioned Setup
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `NotificationService` not found / policy not implemented.

- [ ] **Step 3: Implement `notification.service.ts`**

```typescript
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_TEMPLATE_VERSION,
  SEND_NOTIFICATION_JOB,
  type NotificationType,
  type SendNotificationJobPayload,
} from "@trading-copilot/shared-types";
import { notificationDeliveriesRepository } from "@trading-copilot/database";

/**
 * Mirrors ScreenshotService's requestOrRetryScreenshot + enqueueIfNeeded
 * split exactly: notificationDeliveriesRepository.requestOrRetryNotification
 * is the idempotency boundary (a DB constraint, never re-implemented here),
 * this service only decides whether a BullMQ job needs enqueuing on top of
 * the (possibly pre-existing) row it returns.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue<SendNotificationJobPayload>) {}

  async requestNotification(setupId: string, notificationType: NotificationType): Promise<void> {
    const provider = process.env.NOTIFICATION_MODE === "console" ? "CONSOLE" : "TELEGRAM";
    const { notification, alreadyInFlight } = await notificationDeliveriesRepository.requestOrRetryNotification({
      setupId,
      provider,
      notificationType,
      templateVersion: NOTIFICATION_TEMPLATE_VERSION,
    });

    if (alreadyInFlight && notification.status !== "QUEUED") {
      return;
    }
    await enqueueNotificationIfNeeded(this.queue, notification.id, this.logger);
  }
}

/**
 * Job-state-aware enqueue, mirroring enqueueJobIfNeeded in
 * screenshot.service.ts exactly (and WebhookReconciliationProcessor.reconcileEvent
 * before that) — see either for the full rationale: BullMQ's jobId dedup
 * only blocks a duplicate add() while a job is retained under ANY state,
 * including `failed` (this queue does not set removeOnFail), so a blind
 * add() would permanently no-op once a job has genuinely failed and been
 * reset to QUEUED for retry.
 */
export async function enqueueNotificationIfNeeded(
  queue: Queue<SendNotificationJobPayload>,
  notificationDeliveryId: string,
  logger: Logger,
): Promise<void> {
  const existingJob = await queue.getJob(notificationDeliveryId);

  if (!existingJob) {
    await queue.add(SEND_NOTIFICATION_JOB, { notificationDeliveryId }, { jobId: notificationDeliveryId });
    return;
  }

  const state = await existingJob.getState();
  if (state === "failed") {
    await existingJob.retry("failed");
    return;
  }
  if (state === "completed") {
    logger.warn(`NotificationDelivery ${notificationDeliveryId} has a completed BullMQ job while its row is still QUEUED - skipping re-enqueue; this indicates a bug elsewhere.`);
    return;
  }
  // waiting/active/delayed - already in flight.
}
```

- [ ] **Step 4: Modify `setup.service.ts`'s `updateStatus`**

```typescript
  async updateStatus(id: string, input: UpdateSetupStatusInput): Promise<Setup> {
    const setup = await setupsRepository.transitionSetupStatus(id, {
      status: input.status,
      decisionSummary: input.decisionSummary ?? null,
    });

    if (setup.status === "READY") {
      await this.screenshotService.requestPreTradeScreenshot(setup.id).catch((err: unknown) => {
        this.logger.warn(`Failed to request PRE_TRADE screenshot for Setup ${setup.id}: ${String(err)}`);
      });
    }

    await this.notifyForStatus(setup).catch((err: unknown) => {
      this.logger.warn(`Failed to request notification for Setup ${setup.id} (${setup.status}): ${String(err)}`);
    });

    return setup;
  }

  /**
   * Notification policy (docs/notifications.md "Notification policy"):
   * WATCH never notifies (dashboard-only, avoids alert spam on the noisiest
   * state). PREPARE and READY always notify. INVALIDATED/EXPIRED notify
   * only if a PREPARE or READY notification was already SENT for this
   * setup - an invalidation the human was never told about in the first
   * place needs no "never mind" message. REJECTED behaves like
   * INVALIDATED/EXPIRED (documented as "where useful" in the brief; this
   * codebase treats "already communicated" as the useful case).
   */
  private async notifyForStatus(setup: Setup): Promise<void> {
    if (setup.status === "PREPARE") {
      // The brief requires PREPARE to be "configurable" (unlike READY,
      // which always notifies) - default off, since PREPARE is a much
      // noisier state than READY and the brief's own stated goal for
      // WATCH ("avoid notification spam") applies here too; an operator
      // opts in via NOTIFICATION_PREPARE_ENABLED=true. See
      // docs/notifications.md "Notification policy".
      if (process.env.NOTIFICATION_PREPARE_ENABLED === "true") {
        await this.notificationService.requestNotification(setup.id, "SETUP_PREPARE");
      }
      return;
    }
    if (setup.status === "READY") {
      await this.notificationService.requestNotification(setup.id, "SETUP_READY");
      return;
    }
    if (setup.status === "INVALIDATED" || setup.status === "EXPIRED" || setup.status === "REJECTED") {
      const priorNotification = await notificationDeliveriesRepository.findMostRecentSentNotification(setup.id, [
        "SETUP_PREPARE",
        "SETUP_READY",
      ]);
      if (priorNotification) {
        const notificationType = setup.status === "INVALIDATED" ? "SETUP_INVALIDATED" : setup.status === "EXPIRED" ? "SETUP_EXPIRED" : "SETUP_REJECTED";
        await this.notificationService.requestNotification(setup.id, notificationType);
      }
    }
  }
```

Add `notificationDeliveriesRepository` to the existing `@trading-copilot/database` import, and inject `NotificationService` in the constructor alongside `ScreenshotService`.

- [ ] **Step 5: Wire `NotificationModule` into `apps/api`'s module graph**

`notification.module.ts` registers the `NOTIFICATION_QUEUE` `BullModule.registerQueue` (matching `app.module.ts`'s style for `SCREENSHOT_QUEUE` in `apps/api`'s own producer-side registration — check `screenshot.module.ts` for the exact pattern) and exports `NotificationService`. Import `NotificationModule` into `setup.module.ts` (mirroring how it already imports `ScreenshotModule`).

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @trading-copilot/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/notifications apps/api/src/setups
git commit -m "Milestone 6: NotificationService, setup-status notification policy"
```

---

### Task 9: apps/api — manual execution/skip endpoints, close endpoint update

**Owner:** backend-engineer (depends on Task 4's `createAndRecordJournalTradeEntry` + Task 2's schemas; independent of Tasks 5-8, parallel-safe)

**Files:**
- Modify: `apps/api/src/setups/setup.controller.ts`, `setup.service.ts`
- Modify: `apps/api/src/journal/journal-trade.controller.ts` (confirm only — schema already updated in Task 2)
- Test: extend `apps/api/src/setups/setup.service.test.ts`, `setup.controller`-level test if one exists (check first)

**Interfaces:**
- Produces: `POST /setups/:id/execute` (body: `ExecuteSetupInput`), `POST /setups/:id/skip` (body: `SkipSetupInput`).

- [ ] **Step 1: Write the failing service test**

```typescript
describe("SetupService.execute", () => {
  it("creates and records an OPEN JournalTrade atomically from a Setup's own planned values", async () => {
    // mock setupsRepository.getSetup to return a READY setup with
    // plannedStop/plannedTarget1 set; mock
    // journalTradesRepository.createAndRecordJournalTradeEntry; assert it
    // was called with plannedEntry/plannedStop/etc sourced from the setup,
    // not re-supplied by the input, and executionMode/actualEntry/quantity
    // from the input.
  });

  it("rejects execute for a Setup not in READY status", async () => {
    // mock getSetup to return a PREPARE setup; assert a ConflictException/409
  });
});

describe("SetupService.skip", () => {
  it("creates a SKIPPED JournalTrade with the given reason and preserves the Setup unmodified", async () => {
    // assert journalTradesRepository.createJournalTrade called with
    // executionMode: "SKIPPED", skipReason: "PRICE_MOVED"; assert the
    // Setup's own status is not transitioned by this call (skipping is
    // about the trade decision, not the setup's own lifecycle - a skipped
    // READY setup can still separately expire/be invalidated on its own
    // terms)
  });

  it("allows skip with no reason at all", async () => { /* skipReason: null */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — methods not implemented.

- [ ] **Step 3: Implement `SetupService.execute`/`skip`**

```typescript
  async execute(setupId: string, input: ExecuteSetupInput): Promise<JournalTrade> {
    const setup = await this.getById(setupId);
    if (setup.status !== "READY") {
      throw new ConflictException(`Setup ${setupId} is not READY — cannot record an execution against it`);
    }
    return journalTradesRepository.createAndRecordJournalTradeEntry({
      setupId: setup.id,
      instrumentId: setup.instrumentId,
      strategyId: setup.strategyId,
      strategyVersionId: setup.strategyVersionId,
      direction: setup.direction,
      plannedEntry: setup.plannedEntry,
      plannedStop: setup.plannedStop ?? setup.plannedEntry, // JournalTrade.plannedStop is required; a READY setup with no known stop is itself a data-integrity gap this milestone does not need to solve further (see Task 9 self-review note below) — if this proves wrong in review, the right fix is validating plannedStop is set before allowing a READY transition, not fabricating a stop here.
      plannedTarget1: setup.plannedTarget1,
      plannedTarget2: setup.plannedTarget2,
      plannedRisk: null, // sourced from the Setup's latest RiskCalculation below if one exists
      executionMode: input.executionMode,
      actualEntry: new Decimal(input.actualEntry),
      quantity: input.quantity,
      entryTimestamp: new Date(input.entryTimestamp),
      actualFees: input.actualFees ? new Decimal(input.actualFees) : null,
      actualSlippage: input.actualSlippage ? new Decimal(input.actualSlippage) : null,
      notes: input.notes ?? null,
    });
  }

  async skip(setupId: string, input: SkipSetupInput): Promise<JournalTrade> {
    const setup = await this.getById(setupId);
    return journalTradesRepository.createJournalTrade({
      setupId: setup.id,
      instrumentId: setup.instrumentId,
      strategyId: setup.strategyId,
      strategyVersionId: setup.strategyVersionId,
      direction: setup.direction,
      plannedEntry: setup.plannedEntry,
      plannedStop: setup.plannedStop ?? setup.plannedEntry,
      plannedTarget1: setup.plannedTarget1,
      plannedTarget2: setup.plannedTarget2,
      plannedRisk: null,
      executionMode: "SKIPPED",
      skipReason: input.reason ?? null,
      entryNotes: null,
    });
  }
```

**Self-review note to carry into implementation:** `JournalTrade.plannedStop` is a required `Decimal` column (Milestone 2), but `Setup.plannedStop` is nullable (Milestone 3 — a TradingView-sourced setup can reach READY with only a candidate entry known... **verify this against the actual `transitionSetupStatus` validation in `packages/database/src/repositories/setups.ts` before implementing** — it is plausible that reaching READY already requires `plannedStop`/`plannedTarget1` to be non-null as a transition precondition, in which case the `?? setup.plannedEntry` fallback above is dead code and should be deleted in favor of a plain non-null assertion with a comment citing that precondition. Do not guess; read the real validation function first and implement whichever is actually true.**

Before implementing this task, additionally look up `riskCalculationsRepository.getLatestRiskCalculation` and, when one exists for this setup, pass its `riskBudget` (or an equivalent already-computed risk-amount field — check `RiskCalculation`'s exact field names in `schema.prisma`) as `plannedRisk` instead of `null`, so a trade executed from a setup that had a real risk calculation gets a real `rMultiple` at close time rather than always `null`.

- [ ] **Step 4: Add controller routes**

```typescript
  @Post(":id/execute")
  @UsePipes(new ZodValidationPipe(executeSetupSchema))
  execute(@Param("id", ParseUUIDPipe) id: string, @Body() body: ExecuteSetupInput) {
    return this.setupService.execute(id, body);
  }

  @Post(":id/skip")
  @UsePipes(new ZodValidationPipe(skipSetupSchema))
  skip(@Param("id", ParseUUIDPipe) id: string, @Body() body: SkipSetupInput) {
    return this.setupService.skip(id, body);
  }
```

(Match the existing controller's exact decorator/import style — read `setup.controller.ts` first, in particular how it already applies `ZodValidationPipe` at the parameter level per CLAUDE.md's documented `@UsePipes`-at-method-level gotcha.)

- [ ] **Step 5: Confirm `journal-trade.controller.ts` needs no change**

`closeJournalTradeSchema` already lost `mfe`/`mae` in Task 2; the controller passes the validated body straight through to `JournalTradeService.close`, which was already updated in Task 4 to stop threading `input.mfe`/`input.mae` — but re-check `journal-trade.service.ts`'s `close` method (shown in this plan's research) explicitly: it currently does NOT reference `input.mfe`/`input.mae` at all (they're absent from its destructuring already), so no change is needed there. Just run the full test suite to confirm nothing references the removed fields.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @trading-copilot/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/setups
git commit -m "Milestone 6: POST /setups/:id/execute and /skip"
```

---

### Task 10: apps/api — notification health check

**Owner:** backend-engineer (parallel with Tasks 5-9 — only touches `health.service.ts`)

**Files:**
- Modify: `apps/api/src/health/health.service.ts`
- Test: extend `apps/api/src/health/health.service.test.ts`

**Interfaces:**
- Produces: `NotificationHealth` (`{ status: "HEALTHY" | "DEGRADED" | "DISABLED" | "UNKNOWN"; providerEnabled: boolean; lastSuccessfulNotificationAt: string | null; recentFailureCount: number }`) on `HealthStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("HealthService notification check", () => {
  it("reports DISABLED when NOTIFICATION_MODE is console and TELEGRAM_ENABLED is not true", async () => { /* ... */ });
  it("reports UNKNOWN when Telegram is enabled but no notification has ever been sent", async () => { /* ... */ });
  it("reports DEGRADED when a recent FAILED notification exists", async () => { /* ... */ });
  it("reports HEALTHY only when Telegram is enabled, configured, AND at least one notification has actually SENT — never HEALTHY merely because credentials exist", async () => {
    // this is the brief's explicit "Do not report HEALTHY simply because
    // credentials exist" requirement - the test must set
    // TELEGRAM_ENABLED/BOT_TOKEN/CHAT_ID AND mock a SENT notification, and
    // separately assert that credentials alone (no SENT notification) is
    // NOT reported HEALTHY.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `HealthService`, mirroring `checkScreenshotGeneration`'s exact structure:

```typescript
  private async checkNotifications(): Promise<NotificationHealth> {
    const providerEnabled = isTelegramConfigured(); // import from a small shared location — see note below
    if (!providerEnabled && process.env.NOTIFICATION_MODE !== "telegram") {
      return { status: "DISABLED", providerEnabled: false, lastSuccessfulNotificationAt: null, recentFailureCount: 0 };
    }
    const [mostRecentSent, recentFailureCount] = await Promise.all([
      notificationDeliveriesRepository.findMostRecentSentNotificationOverall(),
      notificationDeliveriesRepository.countRecentFailedNotifications(RECENT_FAILURE_WINDOW_MINUTES),
    ]);
    const status: NotificationHealth["status"] =
      recentFailureCount > 0 ? "DEGRADED" : mostRecentSent ? "HEALTHY" : "UNKNOWN";
    return {
      status,
      providerEnabled,
      lastSuccessfulNotificationAt: mostRecentSent?.sentAt?.toISOString() ?? null,
      recentFailureCount,
    };
  }
```

`isTelegramConfigured` currently lives in `apps/worker/src/notifications/notification-provider.factory.ts` (Task 5) — `apps/api` cannot import from `apps/worker` (apps never import from each other; only from `packages/*`). Move the tiny `isTelegramConfigured` check (three env-var reads, no Telegram-specific logic) into a shared location instead: add it to `packages/shared-types/src/notifications.ts` (Task 2's file) as a plain function taking `env: NodeJS.ProcessEnv`, and have both `apps/worker`'s factory and `apps/api`'s health service import it from there. Update Task 5's file to import and re-export it rather than defining its own copy, to avoid two implementations of the same three-line check drifting apart.

Fold `notificationIsHealthy` into the overall `status` computation the same way `ingestionIsHealthy`/`screenshotGenerationIsHealthy` already are (only `DEGRADED` pulls the overall status down; `DISABLED`/`UNKNOWN` do not).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @trading-copilot/api test -- health`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/health packages/shared-types/src/notifications.ts
git commit -m "Milestone 6: notification subsystem health check"
```

---

### Task 11: platform-engineer — env config, notification:test script

**Owner:** platform-engineer (depends on Task 5's provider factory; parallel with Tasks 8-10)

**Files:**
- Modify: `.env.example`
- Create: `apps/worker/scripts/notification-test.ts`
- Modify: `apps/worker/package.json`

**Interfaces:**
- Produces: `pnpm --filter @trading-copilot/worker notification:test`.

- [ ] **Step 1: Update `.env.example`**

Add a new section, matching the file's existing per-app grouping style:

```
# --- Notifications (Milestone 6) ---

# "console" (default, no credentials needed — logs a sanitized
# representation instead of calling Telegram) or "telegram". Automated
# tests always use the console provider directly, regardless of this
# value — see docs/notifications.md.
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

- [ ] **Step 2: Write `apps/worker/scripts/notification-test.ts`**

```typescript
/**
 * Safe, local-only development utility. Never expose this behavior over an
 * unauthenticated HTTP endpoint — see docs/notifications.md "Testing
 * Telegram locally". Run with:
 *   pnpm --filter @trading-copilot/worker notification:test
 */
import { createNotificationProvider, isTelegramConfigured } from "../src/notifications/notification-provider.factory";

async function main() {
  if (!isTelegramConfigured()) {
    console.log(
      "Telegram is not configured (TELEGRAM_ENABLED/TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not all set) — nothing to send. Set NOTIFICATION_MODE=telegram and all three TELEGRAM_* variables in .env to send a real test message.",
    );
    return;
  }
  const provider = createNotificationProvider();
  const result = await provider.send({
    text: "🔧 Trading Copilot notification:test — this is a manual verification message, not a real trade alert.",
    imageBuffer: null,
  });
  console.log(`Sent. externalMessageId=${result.externalMessageId}`);
}

main().catch((error) => {
  console.error("notification:test failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Add the script to `apps/worker/package.json`**

```json
    "notification:test": "tsx scripts/notification-test.ts",
```

(Use whichever TS-execution tool the workspace already relies on for one-off scripts — check `packages/database/package.json`'s `db:seed` script, which uses `tsx prisma/seed.ts`; match that exactly rather than introducing a second script runner.)

- [ ] **Step 4: Manually verify (documented, not automated)**

Run: `pnpm --filter @trading-copilot/worker notification:test` with no Telegram env set — confirm it prints the "not configured" message and exits 0. This is the "exact manual verification command" the brief's REAL TELEGRAM VALIDATION section asks to be documented (see Task 17).

- [ ] **Step 5: Commit**

```bash
git add .env.example apps/worker/scripts apps/worker/package.json
git commit -m "Milestone 6: Telegram env config, notification:test script"
```

---

### Task 12: apps/dashboard — Setup detail actions + notification status

**Owner:** frontend-engineer (depends on Task 9's endpoints and Task 2's shared-types; parallel with Tasks 5-8, 10-11)

**Files:**
- Modify: `apps/dashboard/src/app/(dashboard)/setups/[id]/page.tsx`
- Modify: `apps/dashboard/src/lib/api.ts`
- Test: component/integration test if the existing page has one (check first — Milestone 5's `page.test.tsx` precedent is for the internal render routes specifically, not this page; if no test exists for this page today, do not introduce a new testing pattern unilaterally — a manual verification note in Task 17 covers this instead).

**Interfaces:**
- Consumes: `POST /setups/:id/execute`, `POST /setups/:id/skip`, `GET /setups/:id` (existing), a new `GET /setups/:id/notifications` list endpoint — **add this thin read endpoint to `setup.controller.ts`/`setup.service.ts` as part of this task** (`NotificationService` from Task 8 does not expose a list method; add `SetupService.listNotifications(id)` calling `notificationDeliveriesRepository.listNotificationsForSetup` directly — this is a trivial single-file read addition, not scope creep, and mirrors how `SetupService` already exposes `listRiskCalculations`).

- [ ] **Step 1: Add dashboard API client functions to `apps/dashboard/src/lib/api.ts`**

Follow the file's existing style exactly (a typed `fetch` wrapper per endpoint, hand-mirrored request/response types — per the system-architect's parked finding from Milestone 5's final review, this file already hand-duplicates types rather than importing the browser-unsafe `shared-types` barrel; continue that established, documented pattern here rather than trying to fix it in this milestone):

```typescript
export interface NotificationDelivery {
  id: string;
  notificationType: string;
  provider: string;
  status: string;
  attemptCount: number;
  sentAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export async function executeSetup(setupId: string, input: {
  executionMode: "PAPER" | "MANUAL_LIVE";
  actualEntry: string;
  quantity: number;
  entryTimestamp: string;
  actualFees?: string;
  actualSlippage?: string;
  notes?: string;
}): Promise<JournalTrade> {
  return apiFetch(`/setups/${setupId}/execute`, { method: "POST", body: JSON.stringify(input) });
}

export async function skipSetup(setupId: string, reason?: string): Promise<JournalTrade> {
  return apiFetch(`/setups/${setupId}/skip`, { method: "POST", body: JSON.stringify({ reason }) });
}

export async function getSetupNotifications(setupId: string): Promise<NotificationDelivery[]> {
  return apiFetch(`/setups/${setupId}/notifications`);
}
```

(Match the real helper name — `apiFetch` is a guess; read the file's actual fetch-wrapper name and existing `JournalTrade` type first and reuse them rather than redefining.)

- [ ] **Step 2: Add action buttons to the Setup detail page**

For a `READY` setup with no existing `JournalTrade`: three buttons — `PAPER TRADE`, `I ENTERED THIS TRADE`, `SKIP TRADE`. Each opens a small form (client component) collecting the fields `executeSetupSchema`/`skipSetupSchema` require, calls the corresponding `lib/api.ts` function, and on success navigates to (or refreshes into) the resulting `JournalTrade`'s detail view. Follow the page's existing form-handling convention (check for an existing form pattern elsewhere in the dashboard, e.g. the risk-calculation or backtest-creation forms, and match its structure/error-display rather than inventing a new one).

Add a "Notifications" status block rendering `getSetupNotifications(setupId)`'s result: provider, notification type, status (with a colored badge, mirroring `StatusBadge.tsx`'s existing component if one exists and is generic enough to reuse — check `apps/dashboard/src/components/StatusBadge.tsx` first), `sentAt`, and `failureMessage` when `FAILED`.

Confirm (do not re-implement) that the PRE_TRADE screenshot display already added in Milestone 5 is still present on this page — this task extends the page, it does not replace Milestone 5's screenshot card.

- [ ] **Step 3: Manual verification**

Start the dashboard against a running API (`pnpm --filter @trading-copilot/dashboard dev`), navigate to a `READY` setup's detail page, confirm all three buttons render and the notification status block renders (even if empty). Full click-through verification happens in Task 17.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/app/\(dashboard\)/setups apps/dashboard/src/lib/api.ts apps/api/src/setups
git commit -m "Milestone 6: dashboard PAPER TRADE / I ENTERED THIS TRADE / SKIP TRADE actions"
```

---

### Task 13: apps/dashboard — Trade detail CLOSE TRADE + outcome display

**Owner:** frontend-engineer (depends on Task 9/Task 2; parallel with Task 12 — different page, but both touch `lib/api.ts`, so this task's implementer must pull Task 12's commit first if dispatched second, per the "avoid concurrent edits to the same file" rule; the controller sequences these two within Phase B rather than launching them simultaneously)

**Files:**
- Modify: `apps/dashboard/src/app/(dashboard)/trades/[id]/page.tsx`
- Modify: `apps/dashboard/src/lib/api.ts`

**Interfaces:**
- Consumes: `POST /journal/trades/:id/close` (existing endpoint, schema already changed in Task 2 to drop `mfe`/`mae`).

- [ ] **Step 1: Update the close form**

Remove any `mfe`/`mae` input fields from the existing close form (if present — the Milestone 5 screenshot work may not have touched this form at all; check its current field list first). The close form's remaining inputs are exactly `closeJournalTradeSchema`'s fields: `actualExit`, `exitTimestamp`, `actualFees` (optional), `actualSlippage` (optional), `exitNotes` (optional).

- [ ] **Step 2: Display server-computed outcome/P&L/R/MFE/MAE**

For a `CLOSED` trade, render `grossPnl`, `netPnl`, `rMultiple` (already existed from Milestone 2 — confirm they're displayed; if not, add them), plus the two new fields: `outcome` (a colored badge: green WIN, red LOSS, gray BREAKEVEN) and `mfe`/`mae` (rendered as `null` → "Not enough candle data" rather than a blank field or a fabricated "0", matching this codebase's "unknown stays unknown" convention used throughout `docs/tradingview-setup.md` and `docs/screenshot-design.md`).

Confirm the POST_TRADE screenshot card (Milestone 5) is unaffected and still renders after close.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/app/\(dashboard\)/trades apps/dashboard/src/lib/api.ts
git commit -m "Milestone 6: CLOSE TRADE form update, outcome/MFE/MAE display"
```

---

## Phase C — Integration, documentation, final verification

### Task 14: Integrate Phase B, run full quality gates

**Owner:** controller (primary session, not delegated)

- Merge/rebase every Phase B branch/commit sequence onto one line of history in the milestone worktree (no two Phase B tasks touched the same file except `lib/api.ts` in Tasks 12/13, already sequenced).
- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` from the worktree root. Fix any integration-only failures (a Prisma Client regeneration is very likely needed after Task 1's migration, mirroring the exact `prisma generate` step required after the Milestone 3/5 merge into `main`).
- Resolve any duplicate-concept findings between parallel tasks before proceeding (e.g. confirm `isTelegramConfigured` has exactly one implementation, per Task 10's note).

### Task 15: Concurrency and idempotency test sweep

**Owner:** data-engineer (or the controller directly — this is verifying Task 4's coverage is real, not writing new production code)

- Confirm `notification-idempotency.integration.test.ts` (Task 4, Step 6) actually exercises 10+ genuinely concurrent `requestOrRetryNotification` calls against live Postgres and passes.
- Add, if not already covered by Task 7's tests: a concurrency test for two simultaneous `SetupService.updateStatus(..., "READY")` calls on the same setup converging on exactly one `NotificationDelivery` row and one BullMQ job (mirror the existing screenshot concurrency test pattern in `apps/api/src/screenshots/screenshot.service.redis.test.ts`, against real Redis).

### Task 16: Documentation

**Owner:** controller (primary session) or a fresh general-purpose dispatch, following Milestone 5's Task 15 precedent (docs written and cross-checked by both an implementer and a reviewer against the real, as-built code — never written speculatively ahead of implementation)

**Files:**
- Create: `docs/notifications.md` — provider abstraction, Telegram config, console mode, the exact notification-policy table (WATCH/PREPARE/READY/INVALIDATED/EXPIRED/REJECTED), idempotency guarantee, retry/backoff behavior and TEMPORARY vs PERMANENT classification, the bounded screenshot-wait behavior (state the exact `NOTIFICATION_SCREENSHOT_WAIT_MS` value), the `notification:test` command and what it does in both configured and unconfigured states.
- Modify: `docs/trade-journal-design.md` — "Skip workflow" section (skip reasons, `executionMode: SKIPPED`), MFE/MAE now server-computed (remove any language implying client input), `outcome` field.
- Modify: `docs/architecture.md` — notification module boundaries (worker owns provider + send; api owns lifecycle + persistence; dashboard never talks to Telegram).
- Modify: `docs/roadmap.md` — mark Milestone 6 complete.
- Modify: `docs/implementation-status.md` — Milestone 6 section following the exact style of the Milestone 3/5 entries already there.
- Modify: `README.md` — Telegram setup instructions, `notification:test` mention.

### Task 17: Real end-to-end verification (controller-run, not delegated)

Mirror Milestone 5's Task 16 discipline exactly — the controller personally drives this against a real running system, not a subagent's self-report:

1. Start `apps/api`, `apps/worker`, `apps/dashboard` (production `start`, not `dev`, to avoid the file-watcher restart failure mode discovered during Milestone 5's own verification).
2. With `NOTIFICATION_MODE=console`: drive a real `Setup` from `WATCH` → `PREPARE` → `READY` via the API and confirm (via `GET /setups/:id/notifications` and the worker's console log output) that exactly one `SETUP_PREPARE` and one `SETUP_READY` notification reach `SENT`, and that the `READY` one's logged text contains real, non-fabricated trade-card values sourced from an actual `RiskCalculation` row (create one first via the existing risk-calculation endpoint).
3. Re-request the same notification type for the same setup (simulating a retry) and confirm no second `NotificationDelivery` row is created.
4. Drive the same setup's `PRE_TRADE` screenshot to `READY` **before** transitioning to `READY` in one run, and confirm the `SETUP_READY` notification's console output notes an attached image; in a second run, transition to `READY` with no screenshot request made at all, and confirm the notification still sends (text-only) within roughly `NOTIFICATION_SCREENSHOT_WAIT_MS`, not indefinitely.
5. Record a `PAPER TRADE` execution against a `READY` setup via the dashboard, confirm the resulting `JournalTrade` is `OPEN` with `executionMode: PAPER`.
6. Close that trade with a real `actualExit` and confirm `grossPnl`/`netPnl`/`rMultiple`/`outcome` are correct by hand-computing them, and that `mfe`/`mae` are non-null and match `calculateExcursions` applied to the real candles in range (a differential check, not just "some number").
7. Confirm the `PRE_TRADE` screenshot's `renderedAt`/`updatedAt` are unchanged after the close, and that a `POST_TRADE` screenshot was queued and reaches `READY`.
8. Record a `SKIP TRADE` with a reason on a different `READY` setup; confirm the resulting `JournalTrade` has `status: SKIPPED` and the given `skipReason`, and that the setup itself is untouched.
9. Run `pnpm --filter @trading-copilot/worker notification:test` with no Telegram credentials set — confirm the documented "not configured" message. If real Telegram credentials happen to be available in the environment, also run it configured and confirm one real message arrives — but treat their absence as expected, not a failure (per the brief's REAL TELEGRAM VALIDATION section).
10. Run the full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` one final time.
11. Dispatch the final whole-branch reviews (system-architect, journal-analyst, quant-engineer, quality-reviewer, per the brief's Section 25/29), resolve all BLOCKER/HIGH findings through the same fix-loop discipline used for Milestones 3/5, then produce the consolidated final report per the brief's Section 31 structure.

---

## Self-review

**Spec coverage:** every numbered section of the brief (1 through 31) maps to a task above — provider abstraction (5), persistence (1, 4), Telegram config (11), console mode (5, 11), notification types/policy (8), trade card (6), screenshot attachment (7), idempotency (4, 15), retry behavior (5, 7), journal integration (1, 4, 7, 8), manual execution (4, 9, 12), paper trade (4, 9, 12), skip (1, 2, 4, 9, 12), trade close (4, 9, 13), POST_TRADE screenshot (already exists from Milestone 2/5 — confirmed unchanged, verified in Task 17), dashboard (12, 13), notification health (10), test Telegram command (11), automated tests (woven through every task's own Steps), real Telegram validation (11, 17), no-AI/no-broker (nothing in any task touches either), documentation (16), quality gates (14), success criteria (17's checklist mirrors the brief's verbatim).

**Placeholder scan:** no task step says "add appropriate error handling" or leaves a function body unwritten. Two steps (Task 9's `plannedStop` fallback, Task 7's relation-shape assumption) explicitly flag a genuine unresolved question for the implementer to verify against real code rather than guess — this is a deliberate, labeled exception (an instruction to *read and confirm*, with the concrete fallback already written either way), not a missing-content placeholder.

**Type consistency:** `NotificationDelivery` (Task 1's Prisma model → Task 1's `trading-domain` interface → Task 4's repository return type → Task 7/10's consumers) uses identical field names throughout. `ExecuteSetupInput`/`SkipSetupInput` (Task 2) match Task 9's controller/service parameter names exactly. `calculateExcursions`'s `{ mfe, mae }` return shape (Task 3) matches Task 4's destructuring exactly. `NotificationProviderError.kind`/`.failureCode` (Task 5) match Task 7's `if (error instanceof NotificationProviderError && error.kind === "PERMANENT")` branch exactly.
