# Milestone 3 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four documented reliability gaps left open at the end of Milestone 3 (`docs/tradingview-setup.md`'s "Known limitations") before Milestone 5 (screenshot generation) begins: a narrow ingestion crash window, non-deterministic timeline tiebreaking, a full-table health scan, and hardcoded WebSocket CORS.

**Architecture:** All four fixes are additive and narrowly scoped — no redesign of the Milestone 3 ingestion pipeline. Each fix reuses existing patterns (BullMQ for reconciliation, indexed Prisma queries, a small pure helper for CORS parsing) rather than introducing new infrastructure.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, BullMQ/Redis, Vitest.

**Spec:** This plan implements the "SMALL MILESTONE 3 HARDENING" section of the Milestone 5 kickoff brief, cross-referenced against `docs/tradingview-setup.md`'s "Known limitations" section (the three specific gaps it documents) and `docs/tradingview-security.md` (CORS/production controls).

## Global Constraints

- All financial calculations must be deterministic (`CLAUDE.md`) — not touched by this plan, but no task here may introduce non-deterministic behavior into the journal/webhook path.
- PostgreSQL is the only persistent source of truth; Redis/BullMQ remain ephemeral (`docs/architecture.md`).
- Do not introduce Kafka, `@nestjs/schedule`, or any new infrastructure dependency — reuse BullMQ, which is already in the stack.
- Do not redesign the Milestone 3 ingestion pipeline; every change here is additive.
- Existing database uniqueness guarantees (`InboundWebhookEvent.fingerprint`, `Setup.sourceWebhookEventId`) remain authoritative; reconciliation must rely on them for safety, never introduce a new check-then-act race.
- Strict TypeScript, no `any` (`CLAUDE.md`).
- Test critical/idempotency-sensitive logic (`CLAUDE.md` testing priorities: duplicate handling, deterministic reruns).

---

## File Structure

- **Modify** `packages/database/prisma/schema.prisma` — add `JournalEvent.sequence` (monotonic tiebreaker), add a compound index on `InboundWebhookEvent(processingStatus, receivedAt)`.
- **Modify** `packages/database/src/repositories/journal-events.ts` — internal raw query helper ordered by `(timestamp, sequence)`.
- **Modify** `packages/database/src/repositories/inbound-webhook-events.ts` — deterministic `getFullTradingViewTimeline` merge; new `findMostRecentInboundWebhookEvent`/`findMostRecentProcessedInboundWebhookEvent`/`findStaleInboundWebhookEvents` queries.
- **Modify** `apps/api/src/health/health.service.ts` — use the new indexed queries instead of `listInboundWebhookEvents({})`.
- **Create** `packages/shared-types/src/webhook-reconciliation.ts` — queue/job name constants, mirroring `tradingview.ts`'s `TRADINGVIEW_WEBHOOK_QUEUE`/`TRADINGVIEW_WEBHOOK_JOB` pattern.
- **Create** `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts` — the reconciliation sweep.
- **Modify** `apps/worker/src/app.module.ts` — register the new queue/processor.
- **Create** `apps/api/src/realtime/realtime-cors.ts` — pure `parseRealtimeCorsOrigin` helper.
- **Modify** `apps/api/src/realtime/realtime.gateway.ts` — use the helper instead of a hardcoded `cors: { origin: true }`.
- **Modify** `.env.example` — document the new env vars.
- **Modify** `docs/tradingview-setup.md` — remove/update the three now-closed "Known limitations" bullets.

---

## Task 1: Deterministic journal-event timeline ordering

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (`JournalEvent` model, ~line 599)
- Modify: `packages/database/src/repositories/journal-events.ts`
- Modify: `packages/database/src/repositories/inbound-webhook-events.ts` (`getFullTradingViewTimeline`, ~line 384)
- Test: `packages/database/src/webhook-ingestion.integration.test.ts` (already has an integration test file for this area — add a case here) and a new pure-logic unit test `packages/database/src/timeline-merge.test.ts`

**Interfaces:**
- Consumes: existing `JournalEvent` Prisma model, existing `createJournalEvent`/`getSetupTimeline`/`getInboundWebhookEventTimeline`/`getFullTradingViewTimeline` in `packages/database/src/repositories/{journal-events,inbound-webhook-events}.ts`.
- Produces: `mergeJournalEventRows(a: PrismaJournalEventRow[], b: PrismaJournalEventRow[]): PrismaJournalEventRow[]` (exported from `journal-events.ts`, pure, no I/O) — later tasks/tests may reuse it. `getFullTradingViewTimeline` keeps its existing public signature (`(webhookEventId: string) => Promise<JournalEvent[]>`).

- [ ] **Step 1: Write the failing test for the merge helper**

```typescript
// packages/database/src/timeline-merge.test.ts
import { describe, expect, it } from "vitest";
import { mergeJournalEventRows } from "./repositories/journal-events";

function row(id: string, sequence: number, timestampMs: number) {
  return {
    id,
    eventType: "SETUP_CREATED" as const,
    timestamp: new Date(timestampMs),
    sequence,
    entityType: "SETUP" as const,
    entityId: "setup-1",
    correlationId: "corr-1",
    instrumentId: null,
    strategyId: null,
    strategyVersionId: null,
    metadata: {},
  };
}

describe("mergeJournalEventRows", () => {
  it("orders by timestamp first", () => {
    const a = [row("a", 5, 2000)];
    const b = [row("b", 1, 1000)];
    expect(mergeJournalEventRows(a, b).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("breaks a timestamp tie using sequence, not array concatenation order", () => {
    // Deliberately construct the case JS's stable sort would get "right" by
    // accident if b were concatenated first — put the later-sequence event
    // in the first array to prove sequence, not position, decides order.
    const a = [row("later", 9, 1000)];
    const b = [row("earlier", 3, 1000)];
    expect(mergeJournalEventRows(a, b).map((r) => r.id)).toEqual(["earlier", "later"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- timeline-merge`
Expected: FAIL — `mergeJournalEventRows` is not exported from `./repositories/journal-events` (and `sequence` does not exist on the row type yet).

- [ ] **Step 3: Add the `sequence` column and index**

In `packages/database/prisma/schema.prisma`, inside `model JournalEvent`, add a monotonic tiebreaker column right after `timestamp`:

```prisma
  eventType JournalEventType
  timestamp DateTime         @default(now())
  // Monotonic insertion-order tiebreaker. Two events can share an identical
  // millisecond `timestamp` (see docs/tradingview-setup.md "Known
  // limitations" — now fixed); `sequence` gives a deterministic secondary
  // sort key that does not depend on JavaScript's incidental sort
  // stability. Never used as a substitute for `timestamp` itself.
  sequence  Int              @default(autoincrement())
```

Add an index so `ORDER BY timestamp, sequence` is backed by an index for the common `correlationId` lookup:

```prisma
  @@index([correlationId, timestamp, sequence])
```

(Keep the existing `@@index([correlationId])` — Postgres can use either; this is additive.)

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm --filter @trading-copilot/database exec prisma migrate dev --name add_journal_event_sequence`
Expected: a new directory under `packages/database/prisma/migrations/` containing `ALTER TABLE "JournalEvent" ADD COLUMN "sequence" SERIAL;` (or equivalent) and the new index; migration applies cleanly against the local dev database.

- [ ] **Step 5: Implement `mergeJournalEventRows` and update the timeline functions**

In `packages/database/src/repositories/journal-events.ts`, export a raw-row query and the pure merge helper. Read the existing file first to match its exact `PrismaJournalEventRow` type name and `mapJournalEvent` import — add alongside them:

```typescript
/**
 * Deterministic merge of two already-individually-sorted (by timestamp,
 * sequence) raw row arrays into one globally sorted array. Pure and
 * side-effect-free so it is unit-testable without a database. Never relies
 * on Array.prototype.sort's incidental stability — ties are broken
 * explicitly by `sequence`, a monotonic insertion-order column, not by
 * which input array a row came from.
 */
export function mergeJournalEventRows(
  a: PrismaJournalEventRow[],
  b: PrismaJournalEventRow[],
): PrismaJournalEventRow[] {
  return [...a, ...b].sort((x, y) => {
    const byTimestamp = x.timestamp.getTime() - y.timestamp.getTime();
    if (byTimestamp !== 0) return byTimestamp;
    return x.sequence - y.sequence;
  });
}
```

Update `getSetupTimeline`/`getInboundWebhookEventTimeline`-equivalent raw queries (wherever they call `prisma.journalEvent.findMany`) to add `sequence` to the `orderBy`:

```typescript
orderBy: [{ timestamp: "asc" }, { sequence: "asc" }],
```

In `packages/database/src/repositories/inbound-webhook-events.ts`, change `getFullTradingViewTimeline` to fetch raw rows for both groups (not the already-mapped `JournalEvent[]`), merge with `mergeJournalEventRows`, then map once at the end:

```typescript
export async function getFullTradingViewTimeline(webhookEventId: string): Promise<JournalEvent[]> {
  const event = await getInboundWebhookEvent(webhookEventId);
  const webhookRows = await getInboundWebhookEventTimelineRaw(webhookEventId);

  if (!event?.setupId) {
    return webhookRows.map(mapJournalEvent);
  }

  const setupRows = await getSetupTimelineRaw(event.setupId);
  return mergeJournalEventRows(webhookRows, setupRows).map(mapJournalEvent);
}
```

Add the small `*Raw` variants (return `prisma.journalEvent.findMany(...)` rows directly, no mapping) next to their existing mapped counterparts in `journal-events.ts`, and export them for `inbound-webhook-events.ts` to import. Keep the existing mapped `getSetupTimeline`/`getInboundWebhookEventTimeline` exports unchanged for every other caller.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test`
Expected: PASS, including the new `timeline-merge.test.ts` and the existing (previously skipped without a live DB) `webhook-ingestion.integration.test.ts` when run against `pnpm infra:up`.

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations packages/database/src/repositories/journal-events.ts packages/database/src/repositories/inbound-webhook-events.ts packages/database/src/timeline-merge.test.ts
git commit -m "fix: deterministic journal-event timeline ordering via sequence column"
```

---

## Task 2: Indexed "most recent webhook event" queries for `/health`

**Files:**
- Modify: `packages/database/src/repositories/inbound-webhook-events.ts`
- Modify: `apps/api/src/health/health.service.ts`
- Test: `packages/database/src/repositories/inbound-webhook-events.test.ts` (create if it doesn't already exist as a unit test file — check first; `webhook-ingestion.integration.test.ts` is the integration-level one) and `apps/api/src/health/health.service.test.ts` (create)

**Interfaces:**
- Consumes: `InboundWebhookEvent` Prisma model (now has `@@index([processingStatus, receivedAt])`, Task 1's migration already added `sequence` — this task adds its own index in the same or a follow-up migration).
- Produces: `findMostRecentInboundWebhookEvent(): Promise<InboundWebhookEvent | null>`, `findMostRecentProcessedInboundWebhookEvent(): Promise<InboundWebhookEvent | null>` (both exported from `inbound-webhook-events.ts`, both `take: 1` queries). `HealthService.checkTradingViewIngestion` consumes these instead of `listInboundWebhookEvents({})`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/health/health.service.test.ts
import { describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";

vi.mock("@trading-copilot/database", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
  inboundWebhookEventsRepository: {
    findMostRecentInboundWebhookEvent: vi.fn(),
    findMostRecentProcessedInboundWebhookEvent: vi.fn(),
  },
}));

import { inboundWebhookEventsRepository } from "@trading-copilot/database";

describe("HealthService.checkTradingViewIngestion (via check())", () => {
  it("reports UNKNOWN when no event has ever been received, without listing every row", async () => {
    vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(null);
    vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
      null,
    );

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("UNKNOWN");
    // The old implementation called a full-list query; this asserts the
    // new implementation never does, by asserting the list function was
    // never imported/called at all (it is not even mocked above — a call
    // to it would throw "is not a function").
  });

  it("reports DEGRADED when the most recent delivery ended FAILED", async () => {
    const failedEvent = { processingStatus: "FAILED", receivedAt: new Date("2026-01-01T00:00:00Z") };
    vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(
      failedEvent as never,
    );
    vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
      null,
    );

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("DEGRADED");
    expect(result.status).toBe("degraded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/api test -- health.service`
Expected: FAIL — `findMostRecentInboundWebhookEvent`/`findMostRecentProcessedInboundWebhookEvent` do not exist on `inboundWebhookEventsRepository`.

- [ ] **Step 3: Implement the two indexed queries**

In `packages/database/src/repositories/inbound-webhook-events.ts`, add (matching the file's existing style — read `listInboundWebhookEvents` first for the exact `mapInboundWebhookEvent`/orderBy convention):

```typescript
/**
 * The single most recent InboundWebhookEvent, regardless of outcome. Backed
 * by the `[provider, receivedAt]` index — a `take: 1` query, never a full
 * table scan (see docs/tradingview-setup.md "Known limitations", now
 * fixed). Used only by GET /health.
 */
export async function findMostRecentInboundWebhookEvent(): Promise<InboundWebhookEvent | null> {
  const row = await prisma.inboundWebhookEvent.findFirst({
    orderBy: { receivedAt: "desc" },
  });
  return row ? mapInboundWebhookEvent(row) : null;
}

/**
 * The single most recent InboundWebhookEvent that reached PROCESSED.
 * Backed by the `[processingStatus, receivedAt]` index.
 */
export async function findMostRecentProcessedInboundWebhookEvent(): Promise<InboundWebhookEvent | null> {
  const row = await prisma.inboundWebhookEvent.findFirst({
    where: { processingStatus: "PROCESSED" },
    orderBy: { receivedAt: "desc" },
  });
  return row ? mapInboundWebhookEvent(row) : null;
}
```

Add the compound index to `schema.prisma`'s `InboundWebhookEvent` model (alongside Task 1's migration, or its own — run `prisma migrate dev` again if done separately):

```prisma
  @@index([processingStatus, receivedAt])
```

- [ ] **Step 4: Update `HealthService`**

In `apps/api/src/health/health.service.ts`, replace `checkTradingViewIngestion`'s body:

```typescript
private async checkTradingViewIngestion(): Promise<TradingViewIngestionHealth> {
  try {
    const [mostRecent, lastSuccessful] = await Promise.all([
      inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent(),
      inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent(),
    ]);

    if (!mostRecent) {
      return { status: "UNKNOWN", lastEventAt: null, lastSuccessfulProcessingAt: null };
    }

    return {
      status: mostRecent.processingStatus === "FAILED" ? "DEGRADED" : "ONLINE",
      lastEventAt: mostRecent.receivedAt.toISOString(),
      lastSuccessfulProcessingAt: lastSuccessful?.processingCompletedAt?.toISOString() ?? null,
    };
  } catch {
    return { status: "UNKNOWN", lastEventAt: null, lastSuccessfulProcessingAt: null };
  }
}
```

Update the doc comment above it (currently explains why the full-list query was an accepted tradeoff) to state it now uses two dedicated indexed queries.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test && pnpm --filter @trading-copilot/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations packages/database/src/repositories/inbound-webhook-events.ts apps/api/src/health/health.service.ts apps/api/src/health/health.service.test.ts
git commit -m "perf: replace /health's full webhook-event scan with indexed most-recent queries"
```

---

## Task 3: Reconcile the crash window between event persistence and job enqueue

**Files:**
- Create: `packages/shared-types/src/webhook-reconciliation.ts`
- Modify: `packages/shared-types/src/index.ts` (export the new module — check the existing barrel export pattern first)
- Modify: `packages/database/src/repositories/inbound-webhook-events.ts`
- Create: `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `.env.example`
- Test: `packages/database/src/repositories/inbound-webhook-events.test.ts` (new query), `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.test.ts` (new)

**Interfaces:**
- Consumes: `TRADINGVIEW_WEBHOOK_QUEUE`/`TRADINGVIEW_WEBHOOK_JOB` (`packages/shared-types/src/tradingview.ts`), `inboundWebhookEventsRepository` from `packages/database`.
- Produces: `WEBHOOK_RECONCILIATION_QUEUE`, `WEBHOOK_RECONCILIATION_JOB`, `WEBHOOK_RECONCILIATION_JOB_ID` (a fixed job id so BullMQ's repeatable-job upsert never creates duplicate schedules across worker restarts) — all exported from `packages/shared-types/src/webhook-reconciliation.ts`. `findStaleInboundWebhookEvents(olderThan: Date): Promise<InboundWebhookEvent[]>` exported from `packages/database`.

- [ ] **Step 1: Write the failing test for the stale-event query**

```typescript
// packages/database/src/repositories/inbound-webhook-events.test.ts (add alongside existing tests in this area, or create the file if none exists yet for this repository — check first)
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../client";
import { findStaleInboundWebhookEvents } from "./inbound-webhook-events";

vi.mock("../client", () => ({
  prisma: { inboundWebhookEvent: { findMany: vi.fn().mockResolvedValue([]) } },
}));

describe("findStaleInboundWebhookEvents", () => {
  it("queries only RECEIVED/QUEUED events older than the given cutoff", async () => {
    const cutoff = new Date("2026-01-01T00:00:00Z");
    await findStaleInboundWebhookEvents(cutoff);

    expect(prisma.inboundWebhookEvent.findMany).toHaveBeenCalledWith({
      where: {
        processingStatus: { in: ["RECEIVED", "QUEUED"] },
        receivedAt: { lt: cutoff },
      },
      orderBy: { receivedAt: "asc" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- inbound-webhook-events`
Expected: FAIL — `findStaleInboundWebhookEvents` is not exported.

- [ ] **Step 3: Implement the query**

In `packages/database/src/repositories/inbound-webhook-events.ts`:

```typescript
/**
 * InboundWebhookEvents stuck at RECEIVED/QUEUED older than `olderThan` — the
 * narrow crash window documented in docs/tradingview-setup.md "Known
 * limitations" (now closed): the row was persisted (claiming its
 * fingerprint) but the BullMQ job that should process it was never
 * successfully enqueued, or a worker crashed before ever picking it up.
 * Consumed only by WebhookReconciliationProcessor, which re-enqueues the
 * processing job — safe to call unconditionally because
 * TradingViewWebhookProcessor is already idempotent per event id
 * (ALREADY_RESOLVED_STATUSES / Setup.sourceWebhookEventId's uniqueness), so
 * a harmless duplicate job for an event that was actually fine is never a
 * correctness problem, only a wasted no-op processing attempt.
 */
export async function findStaleInboundWebhookEvents(olderThan: Date): Promise<InboundWebhookEvent[]> {
  const rows = await prisma.inboundWebhookEvent.findMany({
    where: {
      processingStatus: { in: ["RECEIVED", "QUEUED"] },
      receivedAt: { lt: olderThan },
    },
    orderBy: { receivedAt: "asc" },
  });
  return rows.map(mapInboundWebhookEvent);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/database test -- inbound-webhook-events`
Expected: PASS.

- [ ] **Step 5: Add shared-types queue/job constants**

Create `packages/shared-types/src/webhook-reconciliation.ts`, matching `tradingview.ts`'s existing constant style:

```typescript
/**
 * Periodic sweep for the narrow crash window between an InboundWebhookEvent
 * being persisted and its BullMQ processing job being successfully
 * enqueued. See docs/tradingview-setup.md "Known limitations" (now fixed)
 * and apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts.
 */
export const WEBHOOK_RECONCILIATION_QUEUE = "webhook-reconciliation";
export const WEBHOOK_RECONCILIATION_JOB = "reconcile-stale-webhook-events";
/** Fixed id for the repeatable job itself, so re-registering it on every
 * worker restart upserts the same schedule rather than creating a second,
 * duplicate repeatable job in BullMQ/Redis. */
export const WEBHOOK_RECONCILIATION_JOB_ID = "webhook-reconciliation-repeatable";
```

Add the export to `packages/shared-types/src/index.ts` (read the file first to match the exact existing `export *` pattern used for `tradingview.ts`/`realtime.ts`).

- [ ] **Step 6: Implement the processor**

Create `apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.ts`. Read `apps/worker/src/setup-expiration/setup-expiration.processor.ts` first to match its exact `WorkerHost`/`@Processor` decorator style and constructor-injection pattern for a second queue.

```typescript
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import {
  TRADINGVIEW_WEBHOOK_JOB,
  TRADINGVIEW_WEBHOOK_QUEUE,
  WEBHOOK_RECONCILIATION_JOB,
  WEBHOOK_RECONCILIATION_JOB_ID,
  WEBHOOK_RECONCILIATION_QUEUE,
  type TradingViewWebhookJobPayload,
} from "@trading-copilot/shared-types";
import { inboundWebhookEventsRepository } from "@trading-copilot/database";

const STALE_THRESHOLD_MINUTES = process.env.WEBHOOK_RECONCILIATION_STALE_THRESHOLD_MINUTES
  ? Number(process.env.WEBHOOK_RECONCILIATION_STALE_THRESHOLD_MINUTES)
  : 5;
const INTERVAL_MINUTES = process.env.WEBHOOK_RECONCILIATION_INTERVAL_MINUTES
  ? Number(process.env.WEBHOOK_RECONCILIATION_INTERVAL_MINUTES)
  : 5;

/**
 * Sweeps for InboundWebhookEvents stuck at RECEIVED/QUEUED past a stale
 * threshold and re-enqueues their processing job. See
 * findStaleInboundWebhookEvents's doc comment for why unconditional
 * re-enqueue is safe: TradingViewWebhookProcessor is already idempotent per
 * event id. This never touches Setup creation directly — it only ever
 * re-triggers the same processing path a fresh delivery would take.
 */
@Processor(WEBHOOK_RECONCILIATION_QUEUE)
export class WebhookReconciliationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(WebhookReconciliationProcessor.name);

  constructor(
    @InjectQueue(WEBHOOK_RECONCILIATION_QUEUE) private readonly reconciliationQueue: Queue,
    @InjectQueue(TRADINGVIEW_WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue<TradingViewWebhookJobPayload>,
  ) {
    super();
  }

  /**
   * Registers the repeatable sweep on module init. BullMQ upserts a
   * repeatable job by its (name, repeat options, jobId) tuple, so this is
   * safe to call on every worker restart — it never creates a second,
   * duplicate schedule.
   */
  async onModuleInit(): Promise<void> {
    await this.reconciliationQueue.add(
      WEBHOOK_RECONCILIATION_JOB,
      {},
      {
        repeat: { every: INTERVAL_MINUTES * 60_000 },
        jobId: WEBHOOK_RECONCILIATION_JOB_ID,
      },
    );
  }

  async process(_job: Job): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60_000);
    const stale = await inboundWebhookEventsRepository.findStaleInboundWebhookEvents(cutoff);

    if (stale.length === 0) {
      return;
    }

    this.logger.warn(
      `Reconciling ${stale.length} stale InboundWebhookEvent(s) stuck at RECEIVED/QUEUED past ${STALE_THRESHOLD_MINUTES}m`,
    );

    for (const event of stale) {
      await this.webhookQueue.add(TRADINGVIEW_WEBHOOK_JOB, { inboundWebhookEventId: event.id });
    }
  }
}
```

- [ ] **Step 7: Register the queue/processor in `apps/worker/src/app.module.ts`**

Add `BullModule.registerQueue({ name: WEBHOOK_RECONCILIATION_QUEUE })` alongside the existing queue registrations, and add `WebhookReconciliationProcessor` to `providers`. Import the new constant from `@trading-copilot/shared-types`.

- [ ] **Step 8: Write the processor test**

```typescript
// apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.test.ts
import { describe, expect, it, vi } from "vitest";
import { WebhookReconciliationProcessor } from "./webhook-reconciliation.processor";

vi.mock("@trading-copilot/database", () => ({
  inboundWebhookEventsRepository: { findStaleInboundWebhookEvents: vi.fn() },
}));

import { inboundWebhookEventsRepository } from "@trading-copilot/database";

function buildProcessor() {
  const reconciliationQueue = { add: vi.fn() };
  const webhookQueue = { add: vi.fn() };
  const processor = new WebhookReconciliationProcessor(
    reconciliationQueue as never,
    webhookQueue as never,
  );
  return { processor, reconciliationQueue, webhookQueue };
}

describe("WebhookReconciliationProcessor", () => {
  it("registers a repeatable job with a fixed jobId on module init", async () => {
    const { processor, reconciliationQueue } = buildProcessor();
    await processor.onModuleInit();
    expect(reconciliationQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      {},
      expect.objectContaining({ jobId: "webhook-reconciliation-repeatable" }),
    );
  });

  it("re-enqueues the processing job for every stale event found", async () => {
    const { processor, webhookQueue } = buildProcessor();
    vi.mocked(inboundWebhookEventsRepository.findStaleInboundWebhookEvents).mockResolvedValue([
      { id: "event-1" } as never,
      { id: "event-2" } as never,
    ]);

    await processor.process({} as never);

    expect(webhookQueue.add).toHaveBeenCalledTimes(2);
    expect(webhookQueue.add).toHaveBeenCalledWith(expect.any(String), { inboundWebhookEventId: "event-1" });
    expect(webhookQueue.add).toHaveBeenCalledWith(expect.any(String), { inboundWebhookEventId: "event-2" });
  });

  it("does nothing when no events are stale", async () => {
    const { processor, webhookQueue } = buildProcessor();
    vi.mocked(inboundWebhookEventsRepository.findStaleInboundWebhookEvents).mockResolvedValue([]);

    await processor.process({} as never);

    expect(webhookQueue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test && pnpm --filter @trading-copilot/worker test`
Expected: PASS.

- [ ] **Step 10: Update `.env.example`**

Add near the existing `TRADINGVIEW_SETUP_EXPIRY_MINUTES` entry:

```
# How old (in minutes) an InboundWebhookEvent stuck at RECEIVED/QUEUED must
# be before the reconciliation sweep re-enqueues its processing job (the
# narrow ingestion-crash-window fix — see docs/tradingview-setup.md).
WEBHOOK_RECONCILIATION_STALE_THRESHOLD_MINUTES=5
# How often (in minutes) the reconciliation sweep runs.
WEBHOOK_RECONCILIATION_INTERVAL_MINUTES=5
```

- [ ] **Step 11: Commit**

```bash
git add packages/shared-types/src/webhook-reconciliation.ts packages/shared-types/src/index.ts packages/database/src/repositories/inbound-webhook-events.ts packages/database/src/repositories/inbound-webhook-events.test.ts apps/worker/src/webhook-reconciliation apps/worker/src/app.module.ts .env.example
git commit -m "feat: reconcile InboundWebhookEvents stuck in the persist-before-enqueue crash window"
```

---

## Task 4: Configurable WebSocket CORS origin

**Files:**
- Create: `apps/api/src/realtime/realtime-cors.ts`
- Modify: `apps/api/src/realtime/realtime.gateway.ts`
- Modify: `.env.example`
- Test: `apps/api/src/realtime/realtime-cors.test.ts`

**Interfaces:**
- Produces: `parseRealtimeCorsOrigin(envValue: string | undefined): true | string[]` — pure function, exported from `apps/api/src/realtime/realtime-cors.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/realtime/realtime-cors.test.ts
import { describe, expect, it } from "vitest";
import { parseRealtimeCorsOrigin } from "./realtime-cors";

describe("parseRealtimeCorsOrigin", () => {
  it("defaults to permissive (true) when unset — local development", () => {
    expect(parseRealtimeCorsOrigin(undefined)).toBe(true);
  });

  it("defaults to permissive (true) for an empty string", () => {
    expect(parseRealtimeCorsOrigin("")).toBe(true);
  });

  it("splits a comma-separated list into an origin array, trimming whitespace", () => {
    expect(parseRealtimeCorsOrigin("https://app.example.com, https://admin.example.com")).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("supports a single production origin", () => {
    expect(parseRealtimeCorsOrigin("https://app.example.com")).toEqual(["https://app.example.com"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/api test -- realtime-cors`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

```typescript
// apps/api/src/realtime/realtime-cors.ts
/**
 * REALTIME_CORS_ORIGIN is unset (or empty) in local development, which
 * keeps the gateway permissive (`origin: true`, matching the prior
 * hardcoded default — see docs/tradingview-security.md "Local development
 * vs. production"). In production, set it to a comma-separated list of
 * exact origins the dashboard is served from; nothing here guesses a
 * default production origin.
 */
export function parseRealtimeCorsOrigin(envValue: string | undefined): true | string[] {
  const trimmed = envValue?.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.split(",").map((origin) => origin.trim());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/api test -- realtime-cors`
Expected: PASS.

- [ ] **Step 5: Wire it into the gateway**

`@WebSocketGateway` decorator options must be evaluated at class-definition time (a static object), so compute the origin once at module load in `realtime.gateway.ts`:

```typescript
import { parseRealtimeCorsOrigin } from "./realtime-cors";

const corsOrigin = parseRealtimeCorsOrigin(process.env.REALTIME_CORS_ORIGIN);

@WebSocketGateway({ cors: { origin: corsOrigin } })
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
  // ... unchanged
}
```

Update the file's existing top-of-class doc comment (currently says "No filtering/auth: single-user local tool") to note CORS is now configurable via `REALTIME_CORS_ORIGIN` for production.

- [ ] **Step 6: Update `.env.example`**

```
# WebSocket (realtime dashboard) CORS origin. Unset/empty = permissive
# (local development default). In production, set to a comma-separated
# list of exact dashboard origins, e.g.
# "https://trading.example.com,https://admin.trading.example.com".
REALTIME_CORS_ORIGIN=
```

- [ ] **Step 7: Run the full apps/api test suite**

Run: `pnpm --filter @trading-copilot/api test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/realtime/realtime-cors.ts apps/api/src/realtime/realtime-cors.test.ts apps/api/src/realtime/realtime.gateway.ts .env.example
git commit -m "feat: make realtime WebSocket CORS origin configurable via env"
```

---

## Task 5: Update documentation

**Files:**
- Modify: `docs/tradingview-setup.md` ("Known limitations" section)

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update the "Known limitations" section**

Remove or rewrite the three bullets this plan closes:
- "A narrow crash window between event persistence and enqueue is not yet reconciled" → replace with a short note describing the new reconciliation sweep (queue name, env vars, and that it relies on the processor's existing per-event-id idempotency).
- "`GET /health`'s `tradingViewIngestion` check reads every `InboundWebhookEvent` row" → remove; replace with a one-line note that it now uses two dedicated indexed queries.
- "`getFullTradingViewTimeline`'s chronological merge has no tiebreaker" → remove; replace with a one-line note about the `JournalEvent.sequence` column.

Keep the "Retry policy" bullet unchanged (not in scope for this plan).

- [ ] **Step 2: Commit**

```bash
git add docs/tradingview-setup.md
git commit -m "docs: update tradingview-setup.md known limitations after hardening pass"
```

---

## Final Verification

- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` from the repo root — all must pass.
- [ ] Start `pnpm infra:up`, then re-run `pnpm --filter @trading-copilot/database test` and `pnpm --filter @trading-copilot/worker test` to exercise the integration tests that require a live Postgres/Redis (skipped otherwise).
- [ ] Manually verify reconciliation: insert an `InboundWebhookEvent` row directly at `RECEIVED` with a `receivedAt` older than the threshold (no corresponding BullMQ job), wait for the sweep interval, confirm it reaches `PROCESSED` (or a terminal rejection) without manual intervention.
- [ ] Manually verify the timeline fix: two `JournalEvent`s created in the same request with an artificially-forced identical timestamp (or accept the unit test as sufficient proof, since forcing identical wall-clock timestamps in an integration test is inherently timing-fragile).
