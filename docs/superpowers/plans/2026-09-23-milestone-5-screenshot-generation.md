# Milestone 5 — Deterministic Chart Rendering + Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate deterministic PRE_TRADE and POST_TRADE chart screenshots from our own stored candle data (never TradingView.com) for every TradingView-sourced `Setup` that reaches `READY` and every `JournalTrade` that closes, with a hard, database-enforced guarantee that a PRE_TRADE screenshot can never contain a candle, indicator, or outcome from after the setup's decision time.

**Architecture:** A new internal Next.js render route (`apps/dashboard`) draws a chart from data it fetches through the existing REST API (never a direct database connection — the dashboard never gains DB access it didn't have before). A Playwright-driven BullMQ worker (`apps/worker`) opens that route, waits for an explicit render-ready DOM signal, captures a fixed-size PNG, and hands it to a new storage abstraction package. `apps/api` owns `TradeScreenshot` lifecycle (request/generating/ready/failed) and the one new data-layer guarantee this milestone depends on: a candle query whose `WHERE timestamp <= cutoff` clause is enforced in SQL, never filtered client-side. Every step reuses the existing `JournalEvent` audit trail; no second audit system is introduced.

**Tech Stack:** TypeScript, NestJS, Next.js (App Router), Prisma/PostgreSQL, BullMQ/Redis, Playwright, TradingView Lightweight Charts, Vitest.

**Spec:** This plan implements the "MILESTONE 5 GOAL" through "FINAL REVIEW QUESTIONS" sections of the Milestone 5 kickoff brief, cross-referenced against `docs/screenshot-design.md` (existing design intent), `docs/trade-journal-design.md`'s "Screenshots" section (existing schema foundation), and `docs/architecture.md` (dependency direction, source-of-truth rules). It assumes `docs/superpowers/plans/2026-09-23-milestone-3-hardening.md` has already landed (this plan does not depend on its internals, only on a clean `main`).

## Global Constraints

- **Anti-look-ahead is the highest-priority correctness requirement in this plan.** A PRE_TRADE screenshot must never be reachable from data created, computed, or observed after the Setup's decision time. This is enforced at the data-query layer (SQL `WHERE`), never by hiding elements in React.
- The authoritative PRE_TRADE cutoff timestamp is **`MarketSnapshot.timestamp`** (the `Setup`'s `marketSnapshotId` relation), never `new Date()` and never a `JournalTrade`'s exit time. The authoritative POST_TRADE cutoff is `JournalTrade.exitTimestamp`.
- PostgreSQL remains the only persistent source of truth; the database stores screenshot **metadata** only, never image bytes (`CLAUDE.md`, `docs/screenshot-design.md`).
- The chart renderer never performs authoritative financial calculations — it only displays values already computed by `packages/risk-engine`/the domain services (`docs/architecture.md` "Where financial logic is allowed to live").
- A completed (`READY`) screenshot is immutable historical evidence. A rendering-behavior change bumps `chartConfigVersion`; it never mutates an existing row.
- No automatic broker execution, no runtime AI agents, no Telegram notifications are introduced anywhere in this plan.
- Strict TypeScript, no `any`. Validate all external input (Zod). Keep controllers thin. Test critical calculations (`CLAUDE.md`).
- Do not introduce Kubernetes, Kafka, or microservices. Reuse BullMQ/Redis, already in the stack.

---

## File Structure

- **Modify** `packages/database/prisma/schema.prisma` — extend `TradeScreenshot`, add `ScreenshotStatus` enum, add `SCREENSHOT_*` `JournalEventType` values and `TRADE_SCREENSHOT` `JournalEntityType` value.
- **Modify** `packages/trading-domain/src/journal-entities.ts` — extend the `TradeScreenshot` interface to match.
- **Create** `packages/database/src/repositories/trade-screenshots.ts` — screenshot lifecycle repository.
- **Modify** `packages/database/src/repositories/candles.ts` — add `getCandlesUpToTimestamp`.
- **Modify** `packages/database/src/mappers.ts` — add `mapTradeScreenshot`.
- **Create** `packages/shared-types/src/screenshot.ts` — `ScreenshotType`/`ScreenshotStatus` value arrays, `CHART_CONFIG_VERSION`, render dimensions, `PRE_TRADE_CANDLE_COUNT_DEFAULT`, BullMQ queue/job name constants, request/response Zod schemas.
- **Create** `packages/screenshot-storage` (new package) — `ScreenshotStorage` interface, `LocalDiskScreenshotStorage`, `buildScreenshotStorageKey`.
- **Create** `apps/dashboard/src/app/internal/render/setup/[setupId]/page.tsx` — PRE_TRADE renderer.
- **Create** `apps/dashboard/src/app/internal/render/trade/[tradeId]/page.tsx` — POST_TRADE renderer.
- **Create** `apps/dashboard/src/components/ChartRenderer.tsx` — shared candlestick + annotation + info-panel component, used by both render routes.
- **Create** `apps/api/src/screenshots/` — `screenshot.module.ts`, `screenshot.service.ts`, `screenshot.controller.ts`.
- **Modify** `apps/api/src/setups/setup.module.ts`, `setup.service.ts` — trigger PRE_TRADE generation on `READY`.
- **Modify** `apps/api/src/journal/journal-trade.module.ts`, `journal-trade.service.ts` — trigger POST_TRADE generation on close.
- **Modify** `apps/api/src/market-data/market-data.controller.ts`, `market-data.service.ts` — new cutoff-safe candle endpoint.
- **Modify** `apps/api/src/health/health.service.ts` — screenshot subsystem health.
- **Create** `apps/worker/src/screenshot-generation/screenshot-generation.processor.ts`, `screenshot-render-client.ts`.
- **Modify** `apps/worker/src/app.module.ts` — register the screenshot queue/processor.
- **Modify** `apps/dashboard/src/app/live-setups/LiveSetupsClient.tsx`, `apps/dashboard/src/app/setups/[id]/page.tsx`, `apps/dashboard/src/app/trades/[id]/page.tsx` — screenshot display.
- **Modify** `.env.example`, `README.md`, `docs/architecture.md`, `docs/screenshot-design.md`, `docs/trade-journal-design.md`, `docs/roadmap.md`, `docs/implementation-status.md`.

---

## Task 1: Screenshot domain schema

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/trading-domain/src/journal-entities.ts`
- Modify: `packages/database/src/mappers.ts`
- Test: `packages/database/src/mappers.test.ts`

**Interfaces:**
- Produces: `ScreenshotStatus` Prisma enum (`REQUESTED | GENERATING | READY | FAILED`); `TradeScreenshot` Prisma model gains `status`, `storageProvider`, `renderedAt`, `failureCode`, `failureMessage`, `updatedAt`, and `chartConfigVersion` becomes required (`String`, not `String?`); two uniqueness constraints; `mapTradeScreenshot(row): TradeScreenshot` in `packages/database/src/mappers.ts`.

- [ ] **Step 1: Write the failing mapper test**

```typescript
// packages/database/src/mappers.test.ts (add to existing file — read it first to match its exact style/imports)
describe("mapTradeScreenshot", () => {
  it("maps every field, including nullable ones, without fabricating defaults", () => {
    const row = {
      id: "screenshot-1",
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE" as const,
      status: "READY" as const,
      storageProvider: "LOCAL_DISK",
      storageKey: "setups/setup-1/pre-trade/1.0.0.png",
      mimeType: "image/png",
      width: 1440,
      height: 900,
      marketSnapshotId: "snapshot-1",
      chartConfigVersion: "1.0.0",
      renderedAt: new Date("2026-09-23T00:00:00Z"),
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-09-23T00:00:00Z"),
      updatedAt: new Date("2026-09-23T00:00:00Z"),
    };

    expect(mapTradeScreenshot(row)).toEqual({
      id: "screenshot-1",
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      status: "READY",
      storageProvider: "LOCAL_DISK",
      storageKey: "setups/setup-1/pre-trade/1.0.0.png",
      mimeType: "image/png",
      width: 1440,
      height: 900,
      marketSnapshotId: "snapshot-1",
      chartConfigVersion: "1.0.0",
      renderedAt: new Date("2026-09-23T00:00:00Z"),
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-09-23T00:00:00Z"),
      updatedAt: new Date("2026-09-23T00:00:00Z"),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- mappers`
Expected: FAIL — `mapTradeScreenshot` is not exported, and the row shape doesn't match the current `TradeScreenshot` model.

- [ ] **Step 3: Update the Prisma schema**

In `packages/database/prisma/schema.prisma`, add the enum (near the other Milestone 2 enums) and replace the `TradeScreenshot` model:

```prisma
enum ScreenshotStatus {
  REQUESTED
  GENERATING
  READY
  FAILED
}
```

```prisma
// Metadata only — see docs/screenshot-design.md. Milestone 5: a real
// renderer/Playwright pipeline now populates this. A READY row is
// immutable historical evidence (docs/architecture.md); a behavior change
// bumps chartConfigVersion and creates a NEW row rather than mutating an
// old one — the two @@unique constraints below are what make that
// immutability a database guarantee, not just a convention. Postgres
// treats NULL as distinct from every other NULL for uniqueness purposes,
// so a PRE_TRADE row (tradeId/tradeSource always null) never collides with
// the tradeId-based constraint, and vice versa for a POST_TRADE row.
model TradeScreenshot {
  id String @id @default(uuid())

  setupId String?
  setup   Setup?  @relation(fields: [setupId], references: [id])

  tradeId     String?
  tradeSource TradeSource?

  type   ScreenshotType
  status ScreenshotStatus @default(REQUESTED)

  storageProvider String  @default("LOCAL_DISK")
  storageKey      String?
  mimeType        String?
  width           Int?
  height          Int?

  marketSnapshotId String?

  chartConfigVersion String

  renderedAt DateTime?

  failureCode    String?
  failureMessage String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([setupId, type, chartConfigVersion])
  @@unique([tradeId, tradeSource, type, chartConfigVersion])
  @@index([tradeId, tradeSource])
  @@index([setupId])
  @@index([status])
}
```

Add to `JournalEventType`:

```prisma
  // Milestone 5 — screenshot generation lifecycle. See docs/screenshot-design.md.
  SCREENSHOT_REQUESTED
  SCREENSHOT_GENERATION_STARTED
  SCREENSHOT_CREATED
  SCREENSHOT_FAILED
```

Add to `JournalEntityType`:

```prisma
  TRADE_SCREENSHOT
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm --filter @trading-copilot/database exec prisma migrate dev --name add_screenshot_generation`
Expected: migration applies cleanly. Since no code anywhere writes `TradeScreenshot` today (`docs/trade-journal-design.md`: "No renderer/capture pipeline exists yet"), the table is empty in every environment — making `chartConfigVersion` required and adding the two unique constraints is safe with no backfill needed. If Prisma's migration diff drops and recreates the two existing single-column indexes as part of adding the composite `@@unique`s, that is expected and fine.

- [ ] **Step 5: Update the domain entity**

In `packages/trading-domain/src/journal-entities.ts`, replace the `TradeScreenshot` interface (~line 263):

```typescript
export interface TradeScreenshot {
  id: string;
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  type: ScreenshotType;
  status: ScreenshotStatus;
  storageProvider: string;
  storageKey: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  marketSnapshotId: string | null;
  chartConfigVersion: string;
  renderedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Add `export type ScreenshotStatus = "REQUESTED" | "GENERATING" | "READY" | "FAILED";` next to the existing `ScreenshotType` export in the same file (check where `ScreenshotType` is currently defined/imported and mirror it exactly).

- [ ] **Step 6: Implement `mapTradeScreenshot`**

In `packages/database/src/mappers.ts`, add a `PrismaTradeScreenshotRow` interface and `mapTradeScreenshot` function directly below `mapJournalEvent`, following the exact same field-by-field style as the other mappers in this file (no transformation beyond Prisma's `Decimal`/`Date` → domain types, since this model has no `Decimal` fields).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations packages/trading-domain/src/journal-entities.ts packages/database/src/mappers.ts packages/database/src/mappers.test.ts
git commit -m "feat: extend TradeScreenshot schema for real generation lifecycle"
```

---

## Task 2: Cutoff-safe candle query (the anti-look-ahead guarantee)

**Files:**
- Modify: `packages/database/src/repositories/candles.ts`
- Test: `packages/database/src/repositories/candles.test.ts` (create — check first whether a unit test file already exists for this repository; if not, this is a new file)

**Interfaces:**
- Produces: `getCandlesUpToTimestamp(instrumentId: string, timeframe: Timeframe, cutoffTimestamp: Date, count: number): Promise<Candle[]>`, exported from `packages/database` (add to the barrel export in `packages/database/src/index.ts` if `candles.ts`'s existing exports aren't already re-exported as a namespace — check the pattern used for `getCandles`/`getSurroundingCandles` first and mirror it exactly).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/database/src/repositories/candles.test.ts
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../client";
import { getCandlesUpToTimestamp } from "./candles";

vi.mock("../client", () => ({
  prisma: { candle: { findMany: vi.fn() } },
}));

function candleRow(timestamp: string) {
  return {
    id: `candle-${timestamp}`,
    instrumentId: "instrument-1",
    timeframe: "5m",
    timestamp: new Date(timestamp),
    open: "1", high: "1", low: "1", close: "1", volume: "1",
  };
}

describe("getCandlesUpToTimestamp", () => {
  it("queries with timestamp <= cutoff, descending, limited to count, then returns ascending", async () => {
    const cutoff = new Date("2026-09-18T01:30:00.000Z");
    vi.mocked(prisma.candle.findMany).mockResolvedValue([
      candleRow("2026-09-18T01:30:00.000Z"),
      candleRow("2026-09-18T01:25:00.000Z"),
    ] as never);

    const result = await getCandlesUpToTimestamp("instrument-1", "5m", cutoff, 150);

    expect(prisma.candle.findMany).toHaveBeenCalledWith({
      where: { instrumentId: "instrument-1", timeframe: "5m", timestamp: { lte: cutoff } },
      orderBy: { timestamp: "desc" },
      take: 150,
    });
    // Returned in ascending order (oldest first), matching getCandles'
    // existing convention — never left in the query's descending order.
    expect(result.map((c) => c.timestamp.toISOString())).toEqual([
      "2026-09-18T01:25:00.000Z",
      "2026-09-18T01:30:00.000Z",
    ]);
  });

  it("never includes a candle after the cutoff — the WHERE clause, not client-side filtering, is what excludes it", async () => {
    // This test proves the *call site* asks Postgres to exclude the future
    // candle (via `lte`); it does not and cannot prove Postgres itself
    // enforces `<=` (that is proven by the integration test in Task 2a),
    // but a regression that changed `lte` to `lt`/removed the clause/passed
    // the wrong cutoff would fail this assertion immediately.
    const cutoff = new Date("2026-09-18T01:30:00.000Z");
    vi.mocked(prisma.candle.findMany).mockResolvedValue([]);

    await getCandlesUpToTimestamp("instrument-1", "5m", cutoff, 150);

    const callArgs = vi.mocked(prisma.candle.findMany).mock.calls[0]![0];
    expect(callArgs.where.timestamp).toEqual({ lte: cutoff });
  });

  it("returns fewer than `count` candles when fewer exist, never an error", async () => {
    vi.mocked(prisma.candle.findMany).mockResolvedValue([candleRow("2026-09-18T01:30:00.000Z")] as never);
    const result = await getCandlesUpToTimestamp("instrument-1", "5m", new Date(), 150);
    expect(result).toHaveLength(1);
  });

  it("returns an empty array when no candles exist at or before the cutoff", async () => {
    vi.mocked(prisma.candle.findMany).mockResolvedValue([]);
    const result = await getCandlesUpToTimestamp("instrument-1", "5m", new Date(), 150);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- candles`
Expected: FAIL — `getCandlesUpToTimestamp` is not exported.

- [ ] **Step 3: Implement it**

In `packages/database/src/repositories/candles.ts`, add:

```typescript
/**
 * The anti-look-ahead-safe candle query for chart rendering
 * (docs/screenshot-design.md). `cutoffTimestamp` must be an authoritative
 * decision-time timestamp — MarketSnapshot.timestamp for a PRE_TRADE
 * render, JournalTrade.exitTimestamp for POST_TRADE — never `new Date()`.
 * The `timestamp: { lte: cutoffTimestamp }` clause is enforced by
 * PostgreSQL itself, not filtered out of a larger result set in
 * application code: a future candle is never even fetched, let alone
 * rendered and merely hidden. `count` candles ending at or before the
 * cutoff are returned oldest-first (matching getCandles' existing
 * convention), so a candle exactly at the cutoff is included and a candle
 * even 1ms after it is excluded.
 */
export async function getCandlesUpToTimestamp(
  instrumentId: string,
  timeframe: Timeframe,
  cutoffTimestamp: Date,
  count: number,
): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({
    where: { instrumentId, timeframe, timestamp: { lte: cutoffTimestamp } },
    orderBy: { timestamp: "desc" },
    take: count,
  });
  return rows.reverse().map(mapCandle);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test -- candles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/repositories/candles.ts packages/database/src/repositories/candles.test.ts
git commit -m "feat: add cutoff-safe candle query for anti-look-ahead chart rendering"
```

---

## Task 2a: Integration test proving the cutoff at the database level

**Files:**
- Modify: `packages/database/src/candle-importer.test.ts` or create `packages/database/src/candles.integration.test.ts` (check whether an integration test file already exists for candles specifically — Task 1 of Milestone 3's own integration tests live in dedicated `*.integration.test.ts` files gated on a live Postgres; mirror that exact gating pattern, e.g. `describe.skipIf(!process.env.DATABASE_URL_INTEGRATION_TEST_GATE)` or whatever conditional the existing integration tests use — read one first)

**Interfaces:**
- Consumes: `getCandlesUpToTimestamp` (Task 2), the existing candle-seeding helpers already used by other integration tests in this package.

- [ ] **Step 1: Write the integration test against a real Postgres**

```typescript
it("includes a candle exactly at the cutoff and excludes one 1ms after it", async () => {
  const instrument = await createTestInstrument(); // reuse whatever helper existing integration tests use
  const cutoff = new Date("2026-09-18T01:30:00.000Z");

  await prisma.candle.createMany({
    data: [
      { instrumentId: instrument.id, timeframe: "5m", timestamp: cutoff, open: "1", high: "1", low: "1", close: "1", volume: "1" },
      { instrumentId: instrument.id, timeframe: "5m", timestamp: new Date(cutoff.getTime() + 1), open: "1", high: "1", low: "1", close: "1", volume: "1" },
    ],
  });

  const result = await getCandlesUpToTimestamp(instrument.id, "5m", cutoff, 150);

  expect(result).toHaveLength(1);
  expect(result[0]!.timestamp.getTime()).toBe(cutoff.getTime());
});
```

- [ ] **Step 2: Run against a live database**

Run: `pnpm infra:up && pnpm --filter @trading-copilot/database test`
Expected: PASS (this test is skipped, not failed, when no `DATABASE_URL`/integration gate is available — match the existing skip convention exactly).

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/candles.integration.test.ts
git commit -m "test: prove the candle cutoff query excludes a future candle at the database level"
```

---

## Task 3: `packages/screenshot-storage` — storage abstraction

**Files:**
- Create: `packages/screenshot-storage/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js` (copy the exact shape of an existing small package, e.g. `packages/risk-engine`'s config files, and rename)
- Create: `packages/screenshot-storage/src/index.ts`
- Create: `packages/screenshot-storage/src/storage.ts` — `ScreenshotStorage` interface + `LocalDiskScreenshotStorage`
- Create: `packages/screenshot-storage/src/key.ts` — `buildScreenshotStorageKey`
- Test: `packages/screenshot-storage/src/storage.test.ts`, `packages/screenshot-storage/src/key.test.ts`

**Interfaces:**
- Produces:
  - `interface ScreenshotStorage { save(key: string, data: Buffer, contentType: string): Promise<void>; read(key: string): Promise<Buffer>; exists(key: string): Promise<boolean>; delete(key: string): Promise<void>; }`
  - `class LocalDiskScreenshotStorage implements ScreenshotStorage` (constructor takes `rootDir: string`)
  - `function buildScreenshotStorageKey(input: { setupId: string | null; tradeId: string | null; tradeSource: "BACKTEST_TRADE" | "JOURNAL_TRADE" | null; type: "PRE_TRADE" | "POST_TRADE"; chartConfigVersion: string }): string`
- Consumed by: `apps/worker`'s screenshot processor (Task 7, writes) and `apps/api`'s screenshot controller (Task 8, reads to stream bytes).

- [ ] **Step 1: Scaffold the package**

Run: `ls packages/risk-engine` to see its exact `package.json`/`tsconfig.json`/`eslint.config.js`/`vitest.config.ts` contents, then create `packages/screenshot-storage` with the same files, renaming `@trading-copilot/risk-engine` → `@trading-copilot/screenshot-storage` and clearing its `dependencies` (this package needs only Node's built-in `node:fs/promises` and `node:path` — no `decimal.js`, no database, no NestJS: `docs/architecture.md`'s "packages never depend on apps" and pure-domain-package pattern applies here too).

- [ ] **Step 2: Write the failing key-builder test**

```typescript
// packages/screenshot-storage/src/key.test.ts
import { describe, expect, it } from "vitest";
import { buildScreenshotStorageKey } from "./key";

const SETUP_ID = "11111111-1111-1111-1111-111111111111";
const TRADE_ID = "22222222-2222-2222-2222-222222222222";

describe("buildScreenshotStorageKey", () => {
  it("builds a PRE_TRADE key under setups/<id>/pre-trade/<version>.png", () => {
    expect(
      buildScreenshotStorageKey({
        setupId: SETUP_ID,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toBe(`setups/${SETUP_ID}/pre-trade/1.0.0.png`);
  });

  it("builds a POST_TRADE key under trades/<source>/<id>/post-trade/<version>.png", () => {
    expect(
      buildScreenshotStorageKey({
        setupId: null,
        tradeId: TRADE_ID,
        tradeSource: "JOURNAL_TRADE",
        type: "POST_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toBe(`trades/journal-trade/${TRADE_ID}/post-trade/1.0.0.png`);
  });

  it("rejects an id that is not a well-formed UUID, preventing path traversal from a malformed id", () => {
    expect(() =>
      buildScreenshotStorageKey({
        setupId: "../../etc/passwd",
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toThrow(/not a valid id/i);
  });

  it("rejects a chartConfigVersion containing path separators", () => {
    expect(() =>
      buildScreenshotStorageKey({
        setupId: SETUP_ID,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "../1.0.0",
      }),
    ).toThrow(/invalid chartConfigVersion/i);
  });

  it("requires either setupId or tradeId+tradeSource, never neither", () => {
    expect(() =>
      buildScreenshotStorageKey({
        setupId: null,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        chartConfigVersion: "1.0.0",
      }),
    ).toThrow(/either setupId or tradeId/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/screenshot-storage test -- key`
Expected: FAIL — module does not exist yet.

- [ ] **Step 4: Implement the key builder**

```typescript
// packages/screenshot-storage/src/key.ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[a-zA-Z0-9._-]+$/;

export interface BuildScreenshotStorageKeyInput {
  setupId: string | null;
  tradeId: string | null;
  tradeSource: "BACKTEST_TRADE" | "JOURNAL_TRADE" | null;
  type: "PRE_TRADE" | "POST_TRADE";
  chartConfigVersion: string;
}

/**
 * Generates a storage key internally from our own database-issued UUIDs —
 * never from arbitrary user input directly. Every segment is validated
 * against a strict allowlist regex before being interpolated into a path,
 * so even a caller passing an unexpected string can never traverse outside
 * the intended prefix (CLAUDE.md: never trust external input for
 * filesystem paths).
 */
export function buildScreenshotStorageKey(input: BuildScreenshotStorageKeyInput): string {
  if (!VERSION_RE.test(input.chartConfigVersion)) {
    throw new Error(`Invalid chartConfigVersion "${input.chartConfigVersion}" for a storage key`);
  }
  const typeSegment = input.type === "PRE_TRADE" ? "pre-trade" : "post-trade";

  if (input.setupId) {
    if (!UUID_RE.test(input.setupId)) {
      throw new Error(`setupId "${input.setupId}" is not a valid id`);
    }
    return `setups/${input.setupId}/${typeSegment}/${input.chartConfigVersion}.png`;
  }

  if (input.tradeId && input.tradeSource) {
    if (!UUID_RE.test(input.tradeId)) {
      throw new Error(`tradeId "${input.tradeId}" is not a valid id`);
    }
    const sourceSegment = input.tradeSource === "JOURNAL_TRADE" ? "journal-trade" : "backtest-trade";
    return `trades/${sourceSegment}/${input.tradeId}/${typeSegment}/${input.chartConfigVersion}.png`;
  }

  throw new Error("buildScreenshotStorageKey requires either setupId or tradeId+tradeSource");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/screenshot-storage test -- key`
Expected: PASS.

- [ ] **Step 6: Write the failing storage test**

```typescript
// packages/screenshot-storage/src/storage.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDiskScreenshotStorage } from "./storage";

describe("LocalDiskScreenshotStorage", () => {
  let root: string;
  let storage: LocalDiskScreenshotStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "screenshot-storage-test-"));
    storage = new LocalDiskScreenshotStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a file under the root and reports it as existing", async () => {
    await storage.save("setups/abc/pre-trade/1.0.0.png", Buffer.from("fake-png-bytes"), "image/png");
    expect(await storage.exists("setups/abc/pre-trade/1.0.0.png")).toBe(true);
  });

  it("round-trips the exact bytes written", async () => {
    const data = Buffer.from("fake-png-bytes");
    await storage.save("setups/abc/pre-trade/1.0.0.png", data, "image/png");
    const readBack = await storage.read("setups/abc/pre-trade/1.0.0.png");
    expect(readBack.equals(data)).toBe(true);
  });

  it("creates intermediate directories as needed", async () => {
    await storage.save("deeply/nested/path/1.0.0.png", Buffer.from("x"), "image/png");
    const onDisk = await readFile(join(root, "deeply/nested/path/1.0.0.png"));
    expect(onDisk.toString()).toBe("x");
  });

  it("rejects a key that attempts to escape the storage root via path traversal", async () => {
    await expect(storage.save("../../../etc/passwd", Buffer.from("x"), "image/png")).rejects.toThrow(
      /escapes the storage root/i,
    );
  });

  it("exists() returns false for a key that was never saved", async () => {
    expect(await storage.exists("never/saved.png")).toBe(false);
  });

  it("read() throws a clear error for a missing key", async () => {
    await expect(storage.read("never/saved.png")).rejects.toThrow();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/screenshot-storage test -- storage`
Expected: FAIL — module does not exist.

- [ ] **Step 8: Implement `LocalDiskScreenshotStorage`**

```typescript
// packages/screenshot-storage/src/storage.ts
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface ScreenshotStorage {
  save(key: string, data: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Local-disk implementation for development (docs/screenshot-design.md).
 * Production is expected to swap this for an S3-compatible implementation
 * of the same interface (not implemented in this milestone) — nothing else
 * in this codebase should depend on LocalDiskScreenshotStorage's concrete
 * type, only on ScreenshotStorage.
 */
export class LocalDiskScreenshotStorage implements ScreenshotStorage {
  constructor(private readonly rootDir: string) {}

  private resolvePath(key: string): string {
    const resolved = resolve(this.rootDir, key);
    const rootWithSep = resolve(this.rootDir) + sep;
    if (resolved !== resolve(this.rootDir) && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Storage key "${key}" escapes the storage root`);
    }
    return resolved;
  }

  async save(key: string, data: Buffer, _contentType: string): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    // Write to a temp path then rename, so a crash mid-write never leaves a
    // partially-written file at the real key (docs/screenshot-design.md
    // implies READY only ever means "a complete, valid image exists").
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, data);
    await rename(tmpPath, path);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.resolvePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/screenshot-storage test`
Expected: PASS.

- [ ] **Step 10: Export from the package's index and wire into the workspace**

`packages/screenshot-storage/src/index.ts`:

```typescript
export type { ScreenshotStorage } from "./storage";
export { LocalDiskScreenshotStorage } from "./storage";
export { buildScreenshotStorageKey, type BuildScreenshotStorageKeyInput } from "./key";
```

Run `pnpm install` at the repo root so the new workspace package is linked, then add `"@trading-copilot/screenshot-storage": "workspace:*"` to `apps/worker/package.json` and `apps/api/package.json` dependencies (both need it — the worker writes, the API reads to serve).

- [ ] **Step 11: Run full workspace typecheck/build to confirm the new package is wired correctly**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/screenshot-storage apps/worker/package.json apps/api/package.json pnpm-lock.yaml
git commit -m "feat: add packages/screenshot-storage local-disk storage abstraction"
```

---

## Task 4: Shared screenshot constants and contracts

**Files:**
- Create: `packages/shared-types/src/screenshot.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/screenshot.test.ts`

**Interfaces:**
- Produces: `CHART_CONFIG_VERSION = "1.0.0"`, `PRE_TRADE_CANDLE_COUNT_DEFAULT = 150`, `SCREENSHOT_RENDER_WIDTH = 1440`, `SCREENSHOT_RENDER_HEIGHT = 900`, `SCREENSHOT_QUEUE`, `GENERATE_PRE_TRADE_SCREENSHOT_JOB`, `GENERATE_POST_TRADE_SCREENSHOT_JOB`, `RENDER_READY_TIMEOUT_MS = 15_000`, plus Zod schemas `createPreTradeScreenshotSchema`/`createPostTradeScreenshotSchema` (both currently take no body — the setup/trade id comes from the URL param — so these may simply be `z.object({})`, matching how thin this request body genuinely is; check whether an empty-body endpoint elsewhere in this codebase uses no `@Body()` at all instead, and prefer that simpler pattern if so).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared-types/src/screenshot.test.ts
import { describe, expect, it } from "vitest";
import {
  CHART_CONFIG_VERSION,
  PRE_TRADE_CANDLE_COUNT_DEFAULT,
  SCREENSHOT_RENDER_HEIGHT,
  SCREENSHOT_RENDER_WIDTH,
} from "./screenshot";

describe("screenshot constants", () => {
  it("defines a deterministic render size and candle window", () => {
    expect(SCREENSHOT_RENDER_WIDTH).toBe(1440);
    expect(SCREENSHOT_RENDER_HEIGHT).toBe(900);
    expect(PRE_TRADE_CANDLE_COUNT_DEFAULT).toBe(150);
    expect(CHART_CONFIG_VERSION).toBe("1.0.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/shared-types test -- screenshot`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the constants module**

```typescript
// packages/shared-types/src/screenshot.ts
/**
 * chartConfigVersion for the current rendering configuration (layout,
 * dimensions, visible candle count, annotation behavior). Bump this and
 * only this — never mutate an existing TradeScreenshot row — whenever
 * rendering behavior changes (docs/screenshot-design.md).
 */
export const CHART_CONFIG_VERSION = "1.0.0";

/** Default number of candles ending at/before the cutoff, for a PRE_TRADE render. */
export const PRE_TRADE_CANDLE_COUNT_DEFAULT = 150;

/** Deterministic screenshot dimensions — never a random/ambient browser viewport. */
export const SCREENSHOT_RENDER_WIDTH = 1440;
export const SCREENSHOT_RENDER_HEIGHT = 900;

/** How long Playwright waits for the render-ready DOM signal before treating it as a timeout failure. */
export const RENDER_READY_TIMEOUT_MS = 15_000;

export const SCREENSHOT_QUEUE = "screenshot-generation";
export const GENERATE_PRE_TRADE_SCREENSHOT_JOB = "generate-pre-trade-screenshot";
export const GENERATE_POST_TRADE_SCREENSHOT_JOB = "generate-post-trade-screenshot";

export interface ScreenshotGenerationJobPayload {
  screenshotId: string;
}
```

- [ ] **Step 4: Run test to verify it passes; export from the barrel**

Run: `pnpm --filter @trading-copilot/shared-types test -- screenshot`
Expected: PASS. Add the export to `packages/shared-types/src/index.ts` matching the existing pattern.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types/src/screenshot.ts packages/shared-types/src/screenshot.test.ts packages/shared-types/src/index.ts
git commit -m "feat: add shared screenshot constants (chartConfigVersion, dimensions, queue names)"
```

---

## Task 5: `trade-screenshots` repository (idempotent request/lifecycle)

**Files:**
- Create: `packages/database/src/repositories/trade-screenshots.ts`
- Create: `packages/database/src/errors.ts` addition — `ScreenshotStateError` (check the file first and add alongside `JournalTradeStateError`/`SetupTransitionError`, matching their exact shape)
- Modify: `packages/database/src/index.ts` — export `tradeScreenshotsRepository`
- Test: `packages/database/src/repositories/trade-screenshots.test.ts`

**Interfaces:**
- Produces:
  - `requestOrRetryScreenshot(input: { setupId: string | null; tradeId: string | null; tradeSource: TradeSource | null; type: ScreenshotType; marketSnapshotId: string | null; chartConfigVersion: string }): Promise<{ screenshot: TradeScreenshot; alreadyInFlight: boolean }>`
  - `markScreenshotGenerating(id: string): Promise<TradeScreenshot>`
  - `markScreenshotReady(id: string, input: { storageProvider: string; storageKey: string; mimeType: string; width: number; height: number; renderedAt: Date }): Promise<TradeScreenshot>`
  - `markScreenshotFailed(id: string, input: { failureCode: string; failureMessage: string }): Promise<TradeScreenshot>`
  - `getScreenshot(id): Promise<TradeScreenshot | null>`
  - `listScreenshotsForSetup(setupId): Promise<TradeScreenshot[]>`
  - `listScreenshotsForTrade(tradeId, tradeSource): Promise<TradeScreenshot[]>`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/database/src/repositories/trade-screenshots.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { prisma } from "../client";
import {
  requestOrRetryScreenshot,
  markScreenshotGenerating,
  markScreenshotReady,
  markScreenshotFailed,
} from "./trade-screenshots";

vi.mock("../client", () => ({
  prisma: {
    tradeScreenshot: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    journalEvent: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMockTx())),
  },
}));

function prismaMockTx() {
  return {
    tradeScreenshot: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    journalEvent: { create: vi.fn() },
  };
}

describe("requestOrRetryScreenshot", () => {
  it("creates a new REQUESTED row and emits SCREENSHOT_REQUESTED when none exists", async () => {
    const result = await requestOrRetryScreenshot({
      setupId: "setup-1",
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: "snapshot-1",
      chartConfigVersion: "1.0.0",
    });
    expect(result.alreadyInFlight).toBe(false);
  });
});

describe("markScreenshotReady", () => {
  it("throws if the row is not REQUESTED or GENERATING (never re-marks a READY row)", async () => {
    vi.mocked(prisma.tradeScreenshot.findUnique).mockResolvedValue({ id: "s-1", status: "READY" } as never);
    await expect(
      markScreenshotReady("s-1", {
        storageProvider: "LOCAL_DISK",
        storageKey: "k",
        mimeType: "image/png",
        width: 1440,
        height: 900,
        renderedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
```

(Read `packages/database/src/repositories/journal-trades.ts`'s exact transaction/error-throwing style before finalizing these tests and the implementation below — mirror its `prisma.$transaction`, `NotFoundError`, and state-guard conventions precisely rather than inventing a new style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- trade-screenshots`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the repository**

```typescript
// packages/database/src/repositories/trade-screenshots.ts
import type { ScreenshotType, TradeSource } from "@trading-copilot/shared-types";
import type { ScreenshotStatus, TradeScreenshot } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { ScreenshotStateError, NotFoundError } from "../errors";
import { mapTradeScreenshot } from "../mappers";
import { createJournalEvent } from "./journal-events";

export interface RequestScreenshotInput {
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  type: ScreenshotType;
  marketSnapshotId: string | null;
  chartConfigVersion: string;
}

/**
 * Idempotent per (setupId, type, chartConfigVersion) or
 * (tradeId, tradeSource, type, chartConfigVersion) — the same "database
 * constraint, not check-then-insert" pattern as InboundWebhookEvent.
 * fingerprint (docs/tradingview-setup.md). A pre-existing REQUESTED/
 * GENERATING/READY row is returned as-is (`alreadyInFlight: true` for the
 * first two, since a caller may want to know a job is already running). A
 * pre-existing FAILED row is reset to REQUESTED and returned for
 * reprocessing — this is the only mutation ever applied to a non-terminal
 * screenshot row's own fields, and it never touches a READY row.
 */
// Use whatever type `createJournalEvent`'s own `client` parameter is typed
// as in `journal-events.ts` (e.g. `PrismaClientOrTx`) — reuse that exact
// exported type here rather than inventing a second one.
function findByIdempotencyKey(tx: PrismaClientOrTx, input: RequestScreenshotInput) {
  return tx.tradeScreenshot.findFirst({
    where: input.setupId
      ? { setupId: input.setupId, type: input.type, chartConfigVersion: input.chartConfigVersion }
      : { tradeId: input.tradeId, tradeSource: input.tradeSource, type: input.type, chartConfigVersion: input.chartConfigVersion },
  });
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}

/**
 * `findFirst` then `create` is not race-free on its own — two concurrent
 * calls can both see no existing row and both attempt `create`. The two
 * `@@unique` constraints on `TradeScreenshot` are the actual safety net
 * (same principle as `InboundWebhookEvent.fingerprint`): the loser's
 * `create` throws P2002 inside the transaction. Since a failed
 * `prisma.$transaction` callback aborts that transaction, the P2002 is
 * caught *outside* it, and the loser re-reads the row the winner just
 * committed and returns that instead — never a second row, and never an
 * unhandled rejection out of this function. This mirrors
 * `createInboundWebhookEvent`'s own P2002-catch-and-reread pattern in
 * `inbound-webhook-events.ts` exactly; read that function first before
 * implementing this one.
 */
export async function requestOrRetryScreenshot(
  input: RequestScreenshotInput,
): Promise<{ screenshot: TradeScreenshot; alreadyInFlight: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await findByIdempotencyKey(tx, input);

      if (existing && existing.status !== "FAILED") {
        return { screenshot: mapTradeScreenshot(existing), alreadyInFlight: true };
      }

      if (existing) {
        const retried = await tx.tradeScreenshot.update({
          where: { id: existing.id },
          data: { status: "REQUESTED", failureCode: null, failureMessage: null },
        });
        return { screenshot: mapTradeScreenshot(retried), alreadyInFlight: false };
      }

      const created = await tx.tradeScreenshot.create({
        data: {
          setupId: input.setupId,
          tradeId: input.tradeId,
          tradeSource: input.tradeSource,
          type: input.type,
          marketSnapshotId: input.marketSnapshotId,
          chartConfigVersion: input.chartConfigVersion,
          status: "REQUESTED",
        },
      });

      await createJournalEvent(
        {
          eventType: "SCREENSHOT_REQUESTED",
          entityType: "TRADE_SCREENSHOT",
          entityId: created.id,
          correlationId: input.setupId ?? input.tradeId ?? created.id,
          metadata: { type: input.type, chartConfigVersion: input.chartConfigVersion },
        },
        tx,
      );

      return { screenshot: mapTradeScreenshot(created), alreadyInFlight: false };
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    const winner = await findByIdempotencyKey(prisma, input);
    if (!winner) {
      // Unreachable in practice: a P2002 on these constraints guarantees a
      // matching row exists. Surface the original error rather than fabricate one.
      throw error;
    }
    return { screenshot: mapTradeScreenshot(winner), alreadyInFlight: true };
  }
}

async function requireScreenshot(tx: typeof prisma, id: string) {
  const row = await tx.tradeScreenshot.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("TradeScreenshot", id);
  return row;
}

export async function markScreenshotGenerating(id: string): Promise<TradeScreenshot> {
  return prisma.$transaction(async (tx) => {
    const existing = await requireScreenshot(tx, id);
    if (existing.status !== "REQUESTED") {
      throw new ScreenshotStateError("mark generating", existing.status, "REQUESTED");
    }
    const row = await tx.tradeScreenshot.update({ where: { id }, data: { status: "GENERATING" } });
    await createJournalEvent(
      {
        eventType: "SCREENSHOT_GENERATION_STARTED",
        entityType: "TRADE_SCREENSHOT",
        entityId: id,
        correlationId: row.setupId ?? row.tradeId ?? id,
        metadata: { type: row.type, chartConfigVersion: row.chartConfigVersion },
      },
      tx,
    );
    return mapTradeScreenshot(row);
  });
}

export interface MarkScreenshotReadyInput {
  storageProvider: string;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  renderedAt: Date;
}

export async function markScreenshotReady(
  id: string,
  input: MarkScreenshotReadyInput,
): Promise<TradeScreenshot> {
  return prisma.$transaction(async (tx) => {
    const existing = await requireScreenshot(tx, id);
    if (existing.status !== "GENERATING" && existing.status !== "REQUESTED") {
      throw new ScreenshotStateError("mark ready", existing.status, "GENERATING");
    }
    const row = await tx.tradeScreenshot.update({
      where: { id },
      data: { status: "READY", ...input },
    });
    await createJournalEvent(
      {
        eventType: "SCREENSHOT_CREATED",
        entityType: "TRADE_SCREENSHOT",
        entityId: id,
        correlationId: row.setupId ?? row.tradeId ?? id,
        metadata: { type: row.type, chartConfigVersion: row.chartConfigVersion },
      },
      tx,
    );
    return mapTradeScreenshot(row);
  });
}

export interface MarkScreenshotFailedInput {
  failureCode: string;
  failureMessage: string;
}

export async function markScreenshotFailed(
  id: string,
  input: MarkScreenshotFailedInput,
): Promise<TradeScreenshot> {
  return prisma.$transaction(async (tx) => {
    const existing = await requireScreenshot(tx, id);
    const row = await tx.tradeScreenshot.update({
      where: { id },
      data: { status: "FAILED", failureCode: input.failureCode, failureMessage: input.failureMessage },
    });
    await createJournalEvent(
      {
        eventType: "SCREENSHOT_FAILED",
        entityType: "TRADE_SCREENSHOT",
        entityId: id,
        correlationId: existing.setupId ?? existing.tradeId ?? id,
        metadata: { failureCode: input.failureCode },
      },
      tx,
    );
    return mapTradeScreenshot(row);
  });
}

export async function getScreenshot(id: string): Promise<TradeScreenshot | null> {
  const row = await prisma.tradeScreenshot.findUnique({ where: { id } });
  return row ? mapTradeScreenshot(row) : null;
}

export async function listScreenshotsForSetup(setupId: string): Promise<TradeScreenshot[]> {
  const rows = await prisma.tradeScreenshot.findMany({ where: { setupId }, orderBy: { createdAt: "asc" } });
  return rows.map(mapTradeScreenshot);
}

export async function listScreenshotsForTrade(
  tradeId: string,
  tradeSource: TradeSource,
): Promise<TradeScreenshot[]> {
  const rows = await prisma.tradeScreenshot.findMany({
    where: { tradeId, tradeSource },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapTradeScreenshot);
}
```

Add `ScreenshotStateError` to `packages/database/src/errors.ts`, copying `JournalTradeStateError`'s exact constructor shape (operation, actualStatus, expectedStatus).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test -- trade-screenshots`
Expected: PASS.

- [ ] **Step 5: Export the repository namespace**

In `packages/database/src/index.ts`, export `* as tradeScreenshotsRepository from "./repositories/trade-screenshots"`, matching the exact existing pattern for `journalTradesRepository`/`setupsRepository`.

- [ ] **Step 6: Run the full database package test suite**

Run: `pnpm --filter @trading-copilot/database test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/repositories/trade-screenshots.ts packages/database/src/repositories/trade-screenshots.test.ts packages/database/src/errors.ts packages/database/src/index.ts
git commit -m "feat: add idempotent trade-screenshot lifecycle repository"
```

---

## Task 6: The render-ready contract and `ChartRenderer` component

**Files:**
- Create: `apps/dashboard/src/components/ChartRenderer.tsx`
- Create: `apps/dashboard/src/lib/render-ready.ts` — the shared ready/error DOM-signal helper
- Modify: `apps/dashboard/package.json` — add `lightweight-charts` dependency
- Test: `apps/dashboard/src/lib/render-ready.test.ts`

**Interfaces:**
- Produces: `setRenderReady(): void`, `setRenderError(code: string, message: string): void` (both write to `document.body.dataset`), consumed by both render route pages (Task 7/7a) and by Playwright (Task 9, which reads the same `dataset` keys — the contract must match exactly).
- `ChartRenderer` props: `{ instrument: { symbol: string; tickSize: string }; timeframe: string; strategyLabel: string; direction: "LONG" | "SHORT"; status: string; decisionTimestamp: string; candles: Array<{ timestamp: string; open: string; high: string; low: string; close: string }>; annotations: { entry: string | null; stop: string | null; target1: string | null; target2: string | null; vwap: string | null; support: string | null; resistance: string | null }; infoPanel: Record<string, string | number | null>; onReady: () => void; onError: (code: string, message: string) => void }`.

- [ ] **Step 1: Write the failing test for the ready/error contract**

```typescript
// apps/dashboard/src/lib/render-ready.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { setRenderReady, setRenderError, RENDER_STATE_ATTRIBUTE } from "./render-ready";

describe("render-ready contract", () => {
  beforeEach(() => {
    document.body.removeAttribute(RENDER_STATE_ATTRIBUTE);
    document.body.removeAttribute("data-render-error-code");
    document.body.removeAttribute("data-render-error-message");
  });

  it("setRenderReady sets the ready state Playwright polls for", () => {
    setRenderReady();
    expect(document.body.dataset.renderState).toBe("ready");
  });

  it("setRenderError sets the error state plus a readable code/message", () => {
    setRenderError("NO_CANDLES", "No candles available at or before the cutoff");
    expect(document.body.dataset.renderState).toBe("error");
    expect(document.body.dataset.renderErrorCode).toBe("NO_CANDLES");
    expect(document.body.dataset.renderErrorMessage).toBe("No candles available at or before the cutoff");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/dashboard test -- render-ready`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the contract**

```typescript
// apps/dashboard/src/lib/render-ready.ts
/**
 * The explicit render-ready contract Playwright polls for
 * (docs/screenshot-design.md "Render ready / error" — never an arbitrary
 * sleep). Both render routes (setup and trade) call exactly one of these,
 * exactly once, when the chart has finished drawing (or failed to).
 */
export const RENDER_STATE_ATTRIBUTE = "renderState";

export function setRenderReady(): void {
  document.body.dataset.renderState = "ready";
}

export function setRenderError(code: string, message: string): void {
  document.body.dataset.renderState = "error";
  document.body.dataset.renderErrorCode = code;
  document.body.dataset.renderErrorMessage = message;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/dashboard test -- render-ready`
Expected: PASS.

- [ ] **Step 5: Add the `lightweight-charts` dependency**

Run: `pnpm --filter @trading-copilot/dashboard add lightweight-charts`

- [ ] **Step 6: Implement `ChartRenderer`**

Create `apps/dashboard/src/components/ChartRenderer.tsx` as a client component (`"use client"`). It must:
- Create a Lightweight Charts instance sized exactly `SCREENSHOT_RENDER_WIDTH` × `SCREENSHOT_RENDER_HEIGHT` (import both from `@trading-copilot/shared-types`), never `window.innerWidth`/a responsive container.
- Render a candlestick series from `props.candles` (parse decimal strings to numbers only for the charting library's own rendering — this is display-only, never a value fed back into any calculation; the info panel below renders the original decimal strings verbatim).
- Draw a horizontal price line for each non-null annotation (`entry`/`stop`/`target1`/`target2`/`vwap`/`support`/`resistance`), each labeled and colored distinctly (entry=blue, stop=red, targets=green, vwap=purple/dashed, support/resistance=gray/dashed) — keep it to these seven lines, never more, per "do not clutter the chart."
- Render a compact info panel below/beside the chart from `props.infoPanel`, rendering only keys whose value is not `null` (never fabricate "$0" or "N/A" for a genuinely-missing value — omit the row instead, matching the existing `plannedPriceValue` convention in `apps/dashboard/src/app/setups/[id]/page.tsx`).
- Call `props.onReady()` (wired to `setRenderReady`) once, after the chart's `subscribeCrosshairMove`-free static render has painted — use `chart.timeScale().fitContent()` synchronously then a single `requestAnimationFrame` callback before calling `onReady`, so Playwright never screenshots a blank canvas.
- Wrap the whole render body in a `try/catch`; call `props.onError("RENDER_EXCEPTION", String(err))` on any thrown error instead of leaving the page hung with no ready signal.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/lib/render-ready.ts apps/dashboard/src/lib/render-ready.test.ts apps/dashboard/src/components/ChartRenderer.tsx apps/dashboard/package.json pnpm-lock.yaml
git commit -m "feat: add ChartRenderer component and the Playwright render-ready contract"
```

---

## Task 7: PRE_TRADE internal render route

**Files:**
- Create: `apps/dashboard/src/app/internal/render/setup/[setupId]/page.tsx`
- Modify: `apps/api/src/market-data/market-data.controller.ts`, `market-data.service.ts` (new cutoff-safe candle endpoint)
- Modify: `apps/dashboard/src/lib/api.ts` — add `getCandlesUpToTimestamp` client function
- Test: `apps/api/src/market-data/market-data.service.test.ts` (add a case)

**Interfaces:**
- Produces: `GET /market-data/candles?instrumentId=&timeframe=&cutoffTimestamp=&count=` → `Candle[]`, calling `candlesRepository.getCandlesUpToTimestamp` (Task 2) directly — this is the only path by which any HTTP-reachable code gets cutoff-safe candles.
- The render page calls, server-side, only: `GET /setups/:id`, `GET /market-snapshots/:id`, `GET /setups/:id/risk-calculations/latest` (best-effort, 404 tolerated), `GET /instruments/:id`, and the new candles endpoint. **It must never call any `journal/trades` endpoint** — this is the structural anti-look-ahead guarantee for this route (see Task 12 for the automated test that proves it).

- [ ] **Step 1: Write the failing service test for the new candle endpoint**

```typescript
// apps/api/src/market-data/market-data.service.test.ts (add to existing file — read it first)
it("getCandlesUpToTimestamp delegates to the cutoff-safe repository query, not getCandles", async () => {
  const spy = vi.spyOn(candlesRepository, "getCandlesUpToTimestamp").mockResolvedValue([]);
  await service.getCandlesUpToTimestamp("instrument-1", "5m", new Date("2026-09-18T01:30:00.000Z"), 150);
  expect(spy).toHaveBeenCalledWith("instrument-1", "5m", new Date("2026-09-18T01:30:00.000Z"), 150);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/api test -- market-data.service`
Expected: FAIL.

- [ ] **Step 3: Add the service method and controller route**

In `market-data.service.ts`, add a thin passthrough method calling `candlesRepository.getCandlesUpToTimestamp`. In `market-data.controller.ts`, add:

```typescript
const getCandlesQuerySchema = z.object({
  instrumentId: z.string().uuid(),
  timeframe: z.enum(TIMEFRAMES),
  cutoffTimestamp: z.string().datetime(),
  count: z.coerce.number().int().positive().max(1000).default(PRE_TRADE_CANDLE_COUNT_DEFAULT),
});

@Get("candles")
@UsePipes(new ZodValidationPipe(getCandlesQuerySchema))
getCandles(@Query() query: z.infer<typeof getCandlesQuerySchema>) {
  return this.marketDataService.getCandlesUpToTimestamp(
    query.instrumentId,
    query.timeframe,
    new Date(query.cutoffTimestamp),
    query.count,
  );
}
```

(`max(1000)` is a defensive upper bound so this admin/internal endpoint can never be asked to return an unbounded result set — it is not itself financial logic, just a sane request-size cap, consistent with `CLAUDE.md`'s "validate all external input.")

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/api test -- market-data.service`
Expected: PASS.

- [ ] **Step 5: Add the dashboard API client function**

In `apps/dashboard/src/lib/api.ts`, add `getCandlesUpToTimestamp(instrumentId, timeframe, cutoffTimestamp, count)` matching the exact fetch/error-handling style of the existing `getMarketSnapshot`/`getSetup` functions in that file (read it first).

- [ ] **Step 6: Implement the render route**

```typescript
// apps/dashboard/src/app/internal/render/setup/[setupId]/page.tsx
import {
  getCandlesUpToTimestamp,
  getInstrument,
  getMarketSnapshot,
  getSetup,
  getLatestRiskCalculation,
  ApiError,
} from "@/lib/api";
import { CHART_CONFIG_VERSION, PRE_TRADE_CANDLE_COUNT_DEFAULT } from "@trading-copilot/shared-types";
import RenderClient from "./RenderClient";

export default async function RenderSetupPage({ params }: { params: Promise<{ setupId: string }> }) {
  const { setupId } = await params;

  const setup = await getSetup(setupId).catch(() => null);
  if (!setup) {
    return <RenderClient errorCode="SETUP_NOT_FOUND" errorMessage={`Setup ${setupId} not found`} />;
  }

  const snapshot = await getMarketSnapshot(setup.marketSnapshotId).catch(() => null);
  if (!snapshot) {
    return <RenderClient errorCode="MARKET_SNAPSHOT_NOT_FOUND" errorMessage="Setup's MarketSnapshot is missing" />;
  }

  const instrument = await getInstrument(setup.instrumentId).catch(() => null);

  // Best-effort — a Setup may not have a RiskCalculation yet (plannedStop/
  // plannedTarget1 can still be null at WATCH). Missing is rendered as
  // "unknown", never fabricated.
  const riskCalculation = await getLatestRiskCalculation(setupId).catch(() => null);

  // The one line in this whole route that matters most: the cutoff is
  // MarketSnapshot.timestamp, the Setup's decision time — never
  // `new Date()`. See docs/screenshot-design.md "Authoritative cutoff".
  const candles = await getCandlesUpToTimestamp(
    setup.instrumentId,
    snapshot.timeframe,
    snapshot.timestamp,
    PRE_TRADE_CANDLE_COUNT_DEFAULT,
  ).catch(() => []);

  if (candles.length === 0) {
    return <RenderClient errorCode="NO_CANDLES" errorMessage="No candles available at or before the cutoff" />;
  }

  return (
    <RenderClient
      instrument={instrument ? { symbol: instrument.symbol, tickSize: instrument.tickSize } : null}
      timeframe={snapshot.timeframe}
      direction={setup.direction}
      status={setup.status}
      decisionTimestamp={snapshot.timestamp}
      candles={candles}
      annotations={{
        entry: setup.plannedEntry,
        stop: setup.plannedStop,
        target1: setup.plannedTarget1,
        target2: setup.plannedTarget2,
        vwap: snapshot.vwap,
        support: snapshot.nearestSupport,
        resistance: snapshot.nearestResistance,
      }}
      infoPanel={{
        risk: riskCalculation?.estimatedTotalRisk ?? null,
        quantity: riskCalculation?.calculatedQuantity ?? null,
        riskReward: riskCalculation?.riskReward ?? null,
      }}
      chartConfigVersion={CHART_CONFIG_VERSION}
    />
  );
}
```

Create the small `"use client"` sibling `RenderClient.tsx` that wraps `ChartRenderer`, calling `setRenderError` immediately in a `useEffect` when it received an `errorCode` prop (the not-found/no-candles branches above), or rendering `<ChartRenderer ... onReady={setRenderReady} onError={setRenderError} />` otherwise. This keeps the outer page an `async` server component (so it can `await` the API calls) while the DOM-signal calls (which need `document`) stay in a client component.

- [ ] **Step 7: Manual smoke test**

Run: `pnpm infra:up && pnpm db:migrate && pnpm db:seed && pnpm dev`, then open `http://localhost:3000/internal/render/setup/<a-real-setup-id-from-your-seed-or-a-fired-webhook>` in a browser. Confirm the chart renders and `document.body.dataset.renderState` becomes `"ready"` (inspect via devtools console).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/market-data apps/dashboard/src/app/internal/render/setup apps/dashboard/src/lib/api.ts
git commit -m "feat: add PRE_TRADE internal chart render route"
```

---

## Task 8: POST_TRADE internal render route

**Files:**
- Create: `apps/dashboard/src/app/internal/render/trade/[tradeId]/page.tsx` (+ its own `RenderClient.tsx`, or reuse Task 7's if it's written generically enough — prefer one shared `RenderClient` taking a discriminated `type: "PRE_TRADE" | "POST_TRADE"` prop over duplicating it)
- Modify: `apps/dashboard/src/lib/api.ts` — add `getJournalTrade`

**Interfaces:**
- Consumes: `GET /journal/trades/:id`, plus the same candle/instrument/snapshot endpoints as Task 7, but with `cutoffTimestamp = journalTrade.exitTimestamp` instead of `MarketSnapshot.timestamp`.

- [ ] **Step 1: Implement the render route**

Mirror Task 7's structure exactly, with these differences:
- Fetch `getJournalTrade(tradeId)` instead of `getSetup`. 404/missing → `TRADE_NOT_FOUND`.
- Reject a trade that is not `CLOSED`: `if (trade.status !== "CLOSED") return <RenderClient errorCode="TRADE_NOT_CLOSED" errorMessage="POST_TRADE screenshots require a closed trade" />` — a POST_TRADE screenshot of an open trade would show incomplete/misleading data.
- If `trade.setupId` is set, fetch that `Setup` (best-effort) purely to display original planned levels/context alongside actuals; if not set, planned levels come from `trade.plannedEntry`/`plannedStop`/`plannedTarget1`/`plannedTarget2` directly (`JournalTrade` carries these itself — see `packages/database/prisma/schema.prisma`'s `JournalTrade` model).
- Candle cutoff: `trade.exitTimestamp` (never `new Date()`, never any later timestamp — "Default: include candles through exitTimestamp," `docs` "POST-TRADE DATA WINDOW").
- Additional annotations/info-panel fields: `actualEntry`, `actualExit`, `mfe`, `mae`, `rMultiple`, `netPnl`, and a computed `WIN`/`LOSS`/`BREAKEVEN` label derived the same way the dashboard already labels other trade tables (check `apps/dashboard/src/lib/format.ts` for an existing helper before writing a new one — reuse it if present, since the renderer must not invent its own win/loss classification logic).

- [ ] **Step 2: Manual smoke test**

Close a test `JournalTrade` via `POST /journal/trades/:id/entry` then `POST /journal/trades/:id/close` (or use an existing closed trade from seed data), then open `http://localhost:3000/internal/render/trade/<id>` and confirm it renders with both planned and actual levels.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/app/internal/render/trade apps/dashboard/src/lib/api.ts
git commit -m "feat: add POST_TRADE internal chart render route"
```

---

## Task 9: Playwright screenshot worker

**Files:**
- Modify: `apps/worker/package.json` — add `playwright` (and run `pnpm --filter @trading-copilot/worker exec playwright install chromium` locally/in CI setup — document this in Task 14)
- Create: `apps/worker/src/screenshot-generation/screenshot-generation.processor.ts`
- Create: `apps/worker/src/screenshot-generation/browser-manager.ts` — a shared, lazily-launched Playwright `Browser` instance
- Modify: `apps/worker/src/app.module.ts` — register `SCREENSHOT_QUEUE` (`defaultJobOptions: { attempts: 1 }` — "do not retry indefinitely," per the milestone brief) and the new processor
- Modify: `.env.example` — `DASHBOARD_INTERNAL_BASE_URL`
- Test: `apps/worker/src/screenshot-generation/screenshot-generation.processor.test.ts`

**Interfaces:**
- Consumes: `tradeScreenshotsRepository` (Task 5), `ScreenshotStorage`/`buildScreenshotStorageKey` (Task 3), `RENDER_READY_TIMEOUT_MS`/`SCREENSHOT_RENDER_WIDTH`/`SCREENSHOT_RENDER_HEIGHT` (Task 4).
- Produces: `WebhookReconciliationProcessor`-style `@Processor(SCREENSHOT_QUEUE)` class handling both `GENERATE_PRE_TRADE_SCREENSHOT_JOB` and `GENERATE_POST_TRADE_SCREENSHOT_JOB` (dispatch on `job.name`), payload `{ screenshotId: string }`.

- [ ] **Step 1: Write the failing processor test (mocking Playwright and storage)**

```typescript
// apps/worker/src/screenshot-generation/screenshot-generation.processor.test.ts
import { describe, expect, it, vi } from "vitest";
import { ScreenshotGenerationProcessor } from "./screenshot-generation.processor";

vi.mock("@trading-copilot/database", () => ({
  tradeScreenshotsRepository: {
    getScreenshot: vi.fn(),
    markScreenshotGenerating: vi.fn(),
    markScreenshotReady: vi.fn(),
    markScreenshotFailed: vi.fn(),
  },
}));

import { tradeScreenshotsRepository } from "@trading-copilot/database";

function buildPage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    setViewportSize: vi.fn(),
    goto: vi.fn(),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ state: "ready" }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
    close: vi.fn(),
    ...overrides,
  };
}

function buildProcessor(page: ReturnType<typeof buildPage>, storage = { save: vi.fn(), read: vi.fn(), exists: vi.fn(), delete: vi.fn() }) {
  const browserManager = { getPage: vi.fn().mockResolvedValue(page) };
  const processor = new ScreenshotGenerationProcessor(browserManager as never, storage as never);
  return { processor, storage };
}

describe("ScreenshotGenerationProcessor", () => {
  it("is a no-op when the screenshot row is already READY (idempotent retry)", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({ status: "READY" } as never);
    const page = buildPage();
    const { processor } = buildProcessor(page);

    await processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never);

    expect(page.goto).not.toHaveBeenCalled();
    expect(tradeScreenshotsRepository.markScreenshotGenerating).not.toHaveBeenCalled();
  });

  it("marks READY with storage metadata on a successful render", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "setup-1", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({ evaluate: vi.fn().mockResolvedValue({ state: "ready" }) });
    const { processor, storage } = buildProcessor(page);

    await processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never);

    expect(storage.save).toHaveBeenCalledWith(expect.stringContaining("setups/setup-1/pre-trade/1.0.0.png"), expect.any(Buffer), "image/png");
    expect(tradeScreenshotsRepository.markScreenshotReady).toHaveBeenCalled();
  });

  it("marks FAILED with the renderer's own error code/message when the page signals an error", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "setup-1", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({
      evaluate: vi.fn().mockResolvedValue({ state: "error", code: "NO_CANDLES", message: "No candles available" }),
    });
    const { processor } = buildProcessor(page);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "NO_CANDLES" }),
    );
  });

  it("marks FAILED with RENDER_TIMEOUT when waitForFunction times out", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "setup-1", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage({ waitForFunction: vi.fn().mockRejectedValue(new Error("Timeout 15000ms exceeded")) });
    const { processor } = buildProcessor(page);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "RENDER_TIMEOUT" }),
    );
  });

  it("marks FAILED with STORAGE_WRITE_FAILED when storage.save throws", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1", status: "REQUESTED", setupId: "setup-1", tradeId: null, tradeSource: null,
      type: "PRE_TRADE", chartConfigVersion: "1.0.0",
    } as never);
    const page = buildPage();
    const storage = { save: vi.fn().mockRejectedValue(new Error("disk full")), read: vi.fn(), exists: vi.fn(), delete: vi.fn() };
    const { processor } = buildProcessor(page, storage);

    await expect(
      processor.process({ name: "generate-pre-trade-screenshot", data: { screenshotId: "s-1" } } as never),
    ).rejects.toThrow();

    expect(tradeScreenshotsRepository.markScreenshotFailed).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ failureCode: "STORAGE_WRITE_FAILED" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/worker test -- screenshot-generation`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `browser-manager.ts`**

```typescript
// apps/worker/src/screenshot-generation/browser-manager.ts
import { chromium, type Browser, type Page } from "playwright";

/**
 * One long-lived Chromium instance shared across every screenshot job in
 * this worker process, launched lazily on first use rather than at
 * bootstrap (so a worker that never processes a screenshot job never pays
 * the browser-launch cost). Each job gets its own fresh page/context and
 * closes it when done — only the browser process itself is shared.
 */
export class BrowserManager {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  async getPage(): Promise<Page> {
    const browser = await this.getBrowser();
    return browser.newContext().then((context) => context.newPage());
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
```

- [ ] **Step 4: Implement the processor**

```typescript
// apps/worker/src/screenshot-generation/screenshot-generation.processor.ts
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  GENERATE_POST_TRADE_SCREENSHOT_JOB,
  GENERATE_PRE_TRADE_SCREENSHOT_JOB,
  RENDER_READY_TIMEOUT_MS,
  SCREENSHOT_QUEUE,
  SCREENSHOT_RENDER_HEIGHT,
  SCREENSHOT_RENDER_WIDTH,
  type ScreenshotGenerationJobPayload,
} from "@trading-copilot/shared-types";
import { tradeScreenshotsRepository } from "@trading-copilot/database";
import { buildScreenshotStorageKey, type ScreenshotStorage } from "@trading-copilot/screenshot-storage";
import { BrowserManager } from "./browser-manager";

const DASHBOARD_BASE_URL = process.env.DASHBOARD_INTERNAL_BASE_URL ?? "http://localhost:3000";

interface RenderResult {
  state: "ready" | "error";
  code?: string;
  message?: string;
}

/**
 * See docs/screenshot-design.md "Playwright screenshot worker". Every
 * failure path marks the TradeScreenshot row FAILED (auditable — never a
 * silently-lost job) and rethrows so BullMQ records the job as failed too;
 * SCREENSHOT_QUEUE is configured with attempts: 1, so this never becomes a
 * retry storm (docs' "do not retry indefinitely").
 */
@Processor(SCREENSHOT_QUEUE)
@Injectable()
export class ScreenshotGenerationProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(ScreenshotGenerationProcessor.name);

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly storage: ScreenshotStorage,
  ) {
    super();
  }

  async process(job: Job<ScreenshotGenerationJobPayload>): Promise<void> {
    const { screenshotId } = job.data;
    const screenshot = await tradeScreenshotsRepository.getScreenshot(screenshotId);

    if (!screenshot) {
      throw new Error(`TradeScreenshot ${screenshotId} not found`);
    }
    if (screenshot.status === "READY") {
      this.logger.log(`TradeScreenshot ${screenshotId} already READY; idempotent no-op`);
      return;
    }

    try {
      await tradeScreenshotsRepository.markScreenshotGenerating(screenshotId);

      const renderUrl = this.buildRenderUrl(job.name, screenshot);
      const page = await this.browserManager.getPage();

      try {
        await page.setViewportSize({ width: SCREENSHOT_RENDER_WIDTH, height: SCREENSHOT_RENDER_HEIGHT });

        try {
          await page.goto(renderUrl, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () => document.body.dataset.renderState === "ready" || document.body.dataset.renderState === "error",
            undefined,
            { timeout: RENDER_READY_TIMEOUT_MS },
          );
        } catch {
          throw { failureCode: "RENDER_TIMEOUT", failureMessage: `No render-ready signal within ${RENDER_READY_TIMEOUT_MS}ms` };
        }

        const result = await page.evaluate<RenderResult>(() => {
          const { renderState, renderErrorCode, renderErrorMessage } = document.body.dataset;
          if (renderState === "error") {
            return { state: "error", code: renderErrorCode, message: renderErrorMessage };
          }
          return { state: "ready" };
        });

        if (result.state === "error") {
          throw { failureCode: result.code ?? "RENDER_ERROR", failureMessage: result.message ?? "Unknown render error" };
        }

        let buffer: Buffer;
        try {
          buffer = await page.screenshot();
        } catch (err) {
          throw { failureCode: "SCREENSHOT_CAPTURE_FAILED", failureMessage: String(err) };
        }

        const storageKey = buildScreenshotStorageKey({
          setupId: screenshot.setupId,
          tradeId: screenshot.tradeId,
          tradeSource: screenshot.tradeSource,
          type: screenshot.type,
          chartConfigVersion: screenshot.chartConfigVersion,
        });

        try {
          await this.storage.save(storageKey, buffer, "image/png");
        } catch (err) {
          throw { failureCode: "STORAGE_WRITE_FAILED", failureMessage: String(err) };
        }

        await tradeScreenshotsRepository.markScreenshotReady(screenshotId, {
          storageProvider: "LOCAL_DISK",
          storageKey,
          mimeType: "image/png",
          width: SCREENSHOT_RENDER_WIDTH,
          height: SCREENSHOT_RENDER_HEIGHT,
          renderedAt: new Date(),
        });
      } finally {
        await page.close();
      }
    } catch (err) {
      const { failureCode, failureMessage } =
        err && typeof err === "object" && "failureCode" in err
          ? (err as { failureCode: string; failureMessage: string })
          : { failureCode: "UNKNOWN_ERROR", failureMessage: String(err) };

      await tradeScreenshotsRepository.markScreenshotFailed(screenshotId, { failureCode, failureMessage });
      throw new Error(`Screenshot ${screenshotId} generation failed: ${failureCode} — ${failureMessage}`);
    }
  }

  private buildRenderUrl(jobName: string, screenshot: { setupId: string | null; tradeId: string | null }): string {
    if (jobName === GENERATE_PRE_TRADE_SCREENSHOT_JOB) {
      return `${DASHBOARD_BASE_URL}/internal/render/setup/${screenshot.setupId}`;
    }
    if (jobName === GENERATE_POST_TRADE_SCREENSHOT_JOB) {
      return `${DASHBOARD_BASE_URL}/internal/render/trade/${screenshot.tradeId}`;
    }
    throw new Error(`Unknown screenshot job name: ${jobName}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.browserManager.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/worker test -- screenshot-generation`
Expected: PASS.

- [ ] **Step 6: Register the queue, processor, browser manager, and storage provider**

In `apps/worker/src/app.module.ts`, add `BullModule.registerQueue({ name: SCREENSHOT_QUEUE, defaultJobOptions: { attempts: 1 } })` and add `ScreenshotGenerationProcessor`, `BrowserManager`, and a `ScreenshotStorage` provider (using NestJS's `useFactory`/`useValue` to construct `new LocalDiskScreenshotStorage(process.env.SCREENSHOT_STORAGE_ROOT ?? "./storage/screenshots")`, injected via a token — check whether this codebase already has a precedent for a non-class injection token anywhere; if not, a simple `provide: "SCREENSHOT_STORAGE", useFactory: ...` with a matching `@Inject("SCREENSHOT_STORAGE")` in the processor's constructor is the standard NestJS pattern) to `providers`.

- [ ] **Step 7: Install Playwright's browser binary**

Run: `pnpm --filter @trading-copilot/worker add playwright && pnpm --filter @trading-copilot/worker exec playwright install --with-deps chromium`

- [ ] **Step 8: Update `.env.example`**

```
# apps/worker's Playwright screenshot renderer needs to reach apps/dashboard
# over HTTP to open the internal /internal/render/* routes.
DASHBOARD_INTERNAL_BASE_URL="http://localhost:3000"
# Where LocalDiskScreenshotStorage writes PNGs in development (already
# gitignored — see .gitignore).
SCREENSHOT_STORAGE_ROOT="./storage/screenshots"
```

- [ ] **Step 9: Run the full worker test suite**

Run: `pnpm --filter @trading-copilot/worker test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/screenshot-generation apps/worker/src/app.module.ts apps/worker/package.json .env.example pnpm-lock.yaml
git commit -m "feat: add Playwright-driven screenshot generation BullMQ processor"
```

---

## Task 10: Screenshot APIs and generation triggers

**Files:**
- Create: `apps/api/src/screenshots/screenshot.module.ts`, `screenshot.service.ts`, `screenshot.controller.ts`
- Modify: `apps/api/src/setups/setup.module.ts`, `setup.service.ts` — auto-request PRE_TRADE on `READY`
- Modify: `apps/api/src/journal/journal-trade.module.ts`, `journal-trade.service.ts` — auto-request POST_TRADE on close
- Test: `apps/api/src/screenshots/screenshot.service.test.ts`, additions to `apps/api/src/setups/setup.service.test.ts` and `apps/api/src/journal/journal-trade.service.test.ts`

**Interfaces:**
- Produces:
  - `GET /setups/:id/screenshots` → `TradeScreenshot[]`
  - `POST /setups/:id/screenshots/pre-trade` → `TradeScreenshot` (manual/admin trigger — idempotent, returns the existing row if already requested/ready)
  - `GET /journal/trades/:id/screenshots` → `TradeScreenshot[]`
  - `POST /journal/trades/:id/screenshots/post-trade` → `TradeScreenshot`
  - `ScreenshotService.requestPreTradeScreenshot(setupId: string): Promise<TradeScreenshot>` and `requestPostTradeScreenshot(tradeId: string): Promise<TradeScreenshot>`, both consumed directly by `SetupService`/`JournalTradeService` (not only reachable via HTTP).

- [ ] **Step 1: Write the failing `ScreenshotService` test**

```typescript
// apps/api/src/screenshots/screenshot.service.test.ts
import { describe, expect, it, vi } from "vitest";
import { ScreenshotService } from "./screenshot.service";

vi.mock("@trading-copilot/database", () => ({
  setupsRepository: { getSetup: vi.fn() },
  tradeScreenshotsRepository: { requestOrRetryScreenshot: vi.fn() },
}));

import { setupsRepository, tradeScreenshotsRepository } from "@trading-copilot/database";

describe("ScreenshotService.requestPreTradeScreenshot", () => {
  it("looks up the Setup for its marketSnapshotId, then requests idempotently, then enqueues only when not already in flight", async () => {
    vi.mocked(setupsRepository.getSetup).mockResolvedValue({ id: "setup-1", marketSnapshotId: "snap-1" } as never);
    vi.mocked(tradeScreenshotsRepository.requestOrRetryScreenshot).mockResolvedValue({
      screenshot: { id: "screenshot-1" } as never,
      alreadyInFlight: false,
    });

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);
    const result = await service.requestPreTradeScreenshot("setup-1");

    expect(tradeScreenshotsRepository.requestOrRetryScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ setupId: "setup-1", type: "PRE_TRADE", marketSnapshotId: "snap-1" }),
    );
    expect(queue.add).toHaveBeenCalledWith(expect.any(String), { screenshotId: "screenshot-1" });
    expect(result.id).toBe("screenshot-1");
  });

  it("does not re-enqueue when the screenshot is already in flight", async () => {
    vi.mocked(setupsRepository.getSetup).mockResolvedValue({ id: "setup-1", marketSnapshotId: "snap-1" } as never);
    vi.mocked(tradeScreenshotsRepository.requestOrRetryScreenshot).mockResolvedValue({
      screenshot: { id: "screenshot-1" } as never,
      alreadyInFlight: true,
    });

    const queue = { add: vi.fn() };
    const service = new ScreenshotService(queue as never);
    await service.requestPreTradeScreenshot("setup-1");

    expect(queue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/api test -- screenshot.service`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `ScreenshotService`, `ScreenshotController`, `ScreenshotModule`**

```typescript
// apps/api/src/screenshots/screenshot.service.ts
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  GENERATE_POST_TRADE_SCREENSHOT_JOB,
  GENERATE_PRE_TRADE_SCREENSHOT_JOB,
  CHART_CONFIG_VERSION,
  SCREENSHOT_QUEUE,
  type ScreenshotGenerationJobPayload,
} from "@trading-copilot/shared-types";
import { journalTradesRepository, setupsRepository, tradeScreenshotsRepository } from "@trading-copilot/database";
import type { TradeScreenshot } from "@trading-copilot/trading-domain";

@Injectable()
export class ScreenshotService {
  constructor(
    @InjectQueue(SCREENSHOT_QUEUE) private readonly screenshotQueue: Queue<ScreenshotGenerationJobPayload>,
  ) {}

  async requestPreTradeScreenshot(setupId: string): Promise<TradeScreenshot> {
    const setup = await setupsRepository.getSetup(setupId);
    if (!setup) throw new NotFoundException(`Setup ${setupId} not found`);

    const { screenshot, alreadyInFlight } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
      setupId,
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: setup.marketSnapshotId,
      chartConfigVersion: CHART_CONFIG_VERSION,
    });

    if (!alreadyInFlight) {
      await this.screenshotQueue.add(GENERATE_PRE_TRADE_SCREENSHOT_JOB, { screenshotId: screenshot.id });
    }
    return screenshot;
  }

  async requestPostTradeScreenshot(tradeId: string): Promise<TradeScreenshot> {
    const trade = await journalTradesRepository.getJournalTrade(tradeId);
    if (!trade) throw new NotFoundException(`JournalTrade ${tradeId} not found`);
    if (trade.status !== "CLOSED") {
      throw new NotFoundException(`JournalTrade ${tradeId} is not CLOSED yet — no POST_TRADE screenshot to generate`);
    }

    const { screenshot, alreadyInFlight } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
      setupId: trade.setupId,
      tradeId,
      tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE",
      marketSnapshotId: null,
      chartConfigVersion: CHART_CONFIG_VERSION,
    });

    if (!alreadyInFlight) {
      await this.screenshotQueue.add(GENERATE_POST_TRADE_SCREENSHOT_JOB, { screenshotId: screenshot.id });
    }
    return screenshot;
  }

  listForSetup(setupId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForSetup(setupId);
  }

  listForTrade(tradeId: string): Promise<TradeScreenshot[]> {
    return tradeScreenshotsRepository.listScreenshotsForTrade(tradeId, "JOURNAL_TRADE");
  }
}
```

`screenshot.controller.ts` exposes the four routes listed under "Interfaces" above, `@Controller()`-scoped per NestJS convention as two controllers (`@Controller("setups")` and `@Controller("journal/trades")`, matching the existing route prefixes exactly) or one controller with two route groups — check whether this codebase ever splits routes for the same resource path across two controller classes already (it does not, based on `SetupController`/`JournalTradeController` each owning their whole prefix) and instead **add these routes directly onto the existing `SetupController`/`JournalTradeController`**, injecting `ScreenshotService` into each, rather than creating parallel controllers for the same URL prefixes. Adjust the "Files" list above accordingly: modify `setup.controller.ts`/`journal-trade.controller.ts` instead of creating a new controller class; `ScreenshotService` still lives in its own `screenshots/` module/file, imported by `SetupModule`/`JournalTradeModule`.

`screenshot.module.ts`:

```typescript
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { SCREENSHOT_QUEUE } from "@trading-copilot/shared-types";
import { ScreenshotService } from "./screenshot.service";

@Module({
  imports: [
    BullModule.registerQueue({
      name: SCREENSHOT_QUEUE,
      defaultJobOptions: { attempts: 1 },
    }),
  ],
  providers: [ScreenshotService],
  exports: [ScreenshotService],
})
export class ScreenshotModule {}
```

`SetupModule`/`JournalTradeModule` each add `imports: [ScreenshotModule]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/api test -- screenshot.service`
Expected: PASS.

- [ ] **Step 5: Wire the `READY`-transition trigger into `SetupService`**

In `setup.service.ts`, inject `ScreenshotService` and update `updateStatus`:

```typescript
async updateStatus(id: string, input: UpdateSetupStatusInput): Promise<Setup> {
  const setup = await setupsRepository.transitionSetupStatus(id, {
    status: input.status,
    decisionSummary: input.decisionSummary ?? null,
  });

  // Screenshot generation is best-effort and must never fail the status
  // transition it is a side effect of — see the milestone brief's
  // "When to generate PRE_TRADE screenshot": a READY setup should have a
  // PRE_TRADE screenshot or a queued generation record, but a screenshot
  // subsystem hiccup is never a reason to reject an otherwise-valid
  // WATCH/PREPARE/READY/REJECTED/INVALIDATED/EXPIRED transition.
  if (setup.status === "READY") {
    await this.screenshotService.requestPreTradeScreenshot(setup.id).catch((err) => {
      this.logger.warn(`Failed to request PRE_TRADE screenshot for Setup ${setup.id}: ${err}`);
    });
  }

  return setup;
}
```

Add a `private readonly logger = new Logger(SetupService.name);` field and the `ScreenshotService` constructor injection.

- [ ] **Step 6: Write a test proving the trigger fires exactly on `READY`, and only on `READY`**

Add to `apps/api/src/setups/setup.service.test.ts`:

```typescript
it("requests a PRE_TRADE screenshot when a Setup transitions to READY", async () => {
  vi.mocked(setupsRepository.transitionSetupStatus).mockResolvedValue({ id: "setup-1", status: "READY" } as never);
  const screenshotService = { requestPreTradeScreenshot: vi.fn().mockResolvedValue({}) };
  const service = new SetupService(screenshotService as never);

  await service.updateStatus("setup-1", { status: "READY" });

  expect(screenshotService.requestPreTradeScreenshot).toHaveBeenCalledWith("setup-1");
});

it("does not request a screenshot for a non-READY transition", async () => {
  vi.mocked(setupsRepository.transitionSetupStatus).mockResolvedValue({ id: "setup-1", status: "PREPARE" } as never);
  const screenshotService = { requestPreTradeScreenshot: vi.fn() };
  const service = new SetupService(screenshotService as never);

  await service.updateStatus("setup-1", { status: "PREPARE" });

  expect(screenshotService.requestPreTradeScreenshot).not.toHaveBeenCalled();
});

it("does not let a screenshot-request failure fail the status transition itself", async () => {
  vi.mocked(setupsRepository.transitionSetupStatus).mockResolvedValue({ id: "setup-1", status: "READY" } as never);
  const screenshotService = { requestPreTradeScreenshot: vi.fn().mockRejectedValue(new Error("queue down")) };
  const service = new SetupService(screenshotService as never);

  await expect(service.updateStatus("setup-1", { status: "READY" })).resolves.toMatchObject({ status: "READY" });
});
```

- [ ] **Step 7: Wire the close-trade trigger into `JournalTradeService`**

Mirror Step 5/6 exactly for `journal-trade.service.ts`'s `close` method: after `journalTradesRepository.closeJournalTrade` resolves, if `trade.setupId` is set, call `this.screenshotService.requestPostTradeScreenshot(trade.id).catch(...)` the same best-effort way. If `trade.setupId` is null (a `JournalTrade` created without a `Setup`, per the schema's nullable `setupId`), still request a POST_TRADE screenshot keyed on `tradeId` alone — `ScreenshotService.requestPostTradeScreenshot` already handles `trade.setupId: null` correctly (Step 3's implementation passes it straight through).

- [ ] **Step 8: Run the full apps/api test suite**

Run: `pnpm --filter @trading-copilot/api test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/screenshots apps/api/src/setups apps/api/src/journal
git commit -m "feat: add screenshot APIs and auto-trigger generation on READY/close"
```

---

## Task 11: Screenshot byte-serving route

**Files:**
- Modify: `apps/api/src/screenshots/screenshot.controller.ts` (or wherever Task 10 landed the routes)
- Test: an addition to that controller's test file

**Interfaces:**
- Produces: `GET /screenshots/:id/image` — streams the PNG bytes for a `READY` screenshot; 404 for anything else (missing row, or a row not yet `READY`). This is the "controlled application route" the milestone brief asks for instead of exposing the storage directory publicly.

- [ ] **Step 1: Write the failing test**

```typescript
it("streams image bytes for a READY screenshot", async () => {
  vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
    id: "s-1", status: "READY", storageKey: "setups/setup-1/pre-trade/1.0.0.png", mimeType: "image/png",
  } as never);
  const storage = { read: vi.fn().mockResolvedValue(Buffer.from("png-bytes")) };
  const controller = new ScreenshotController(/* ...as constructed elsewhere in this file... */, storage as never);

  const res = { setHeader: vi.fn(), send: vi.fn() };
  await controller.getImage("s-1", res as never);

  expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
  expect(res.send).toHaveBeenCalledWith(Buffer.from("png-bytes"));
});

it("404s for a screenshot that is not yet READY", async () => {
  vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({ id: "s-1", status: "GENERATING" } as never);
  // ... expect NotFoundException
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/api test -- screenshot`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

```typescript
@Get("screenshots/:id/image")
async getImage(@Param("id", new ParseUUIDPipe()) id: string, @Res() res: Response) {
  const screenshot = await tradeScreenshotsRepository.getScreenshot(id);
  if (!screenshot || screenshot.status !== "READY" || !screenshot.storageKey || !screenshot.mimeType) {
    throw new NotFoundException(`No ready screenshot image for ${id}`);
  }
  const bytes = await this.storage.read(screenshot.storageKey);
  res.setHeader("Content-Type", screenshot.mimeType);
  res.send(bytes);
}
```

Inject the same `ScreenshotStorage` token used in Task 9's worker wiring (apps/api needs its own provider registration for it, reading `SCREENSHOT_STORAGE_ROOT` the same way).

- [ ] **Step 4: Run tests to verify they pass; commit**

Run: `pnpm --filter @trading-copilot/api test`

```bash
git add apps/api/src/screenshots
git commit -m "feat: serve screenshot PNG bytes through a controlled API route"
```

---

## Task 12: Anti-look-ahead and immutability automated tests

**Files:**
- Create: `apps/dashboard/src/app/internal/render/setup/route-boundaries.test.ts` (or colocate differently if the dashboard's test conventions prefer — check `apps/dashboard`'s existing test file locations first)
- Create: `packages/database/src/screenshot-immutability.integration.test.ts`

**Interfaces:** None new — this task is pure verification of guarantees Tasks 1–10 already built.

- [ ] **Step 1: Static-analysis test that the PRE_TRADE render route never imports a journal-trade API call**

```typescript
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PRE_TRADE render route anti-look-ahead boundary", () => {
  it("never references getJournalTrade or any /journal/trades endpoint", () => {
    const source = readFileSync(
      "apps/dashboard/src/app/internal/render/setup/[setupId]/page.tsx",
      "utf-8",
    );
    expect(source).not.toMatch(/getJournalTrade|journal\/trades/);
  });
});
```

- [ ] **Step 2: Integration test — closing a trade never changes its Setup's PRE_TRADE screenshot row**

```typescript
it("leaves a Setup's PRE_TRADE TradeScreenshot completely unchanged after its trade closes", async () => {
  // Set up: create instrument/strategy/setup/journal trade via existing
  // integration-test helpers, create a READY PRE_TRADE TradeScreenshot row
  // via requestOrRetryScreenshot + markScreenshotReady (no real Playwright
  // needed for this test — only the database rows matter).
  const before = await tradeScreenshotsRepository.getScreenshot(preTradeScreenshotId);

  await journalTradesRepository.recordJournalTradeEntry(tradeId, { /* ... */ });
  await journalTradesRepository.closeJournalTrade(tradeId, { /* ... */ });

  const after = await tradeScreenshotsRepository.getScreenshot(preTradeScreenshotId);
  expect(after).toEqual(before);
});

it("a POST_TRADE screenshot never overwrites the PRE_TRADE row for the same Setup", async () => {
  const { screenshot: postTrade } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
    setupId, tradeId, tradeSource: "JOURNAL_TRADE", type: "POST_TRADE", marketSnapshotId: null, chartConfigVersion: CHART_CONFIG_VERSION,
  });
  expect(postTrade.id).not.toBe(preTradeScreenshotId);
  const preTradeStillThere = await tradeScreenshotsRepository.getScreenshot(preTradeScreenshotId);
  expect(preTradeStillThere?.status).toBe("READY");
});

it("a chartConfigVersion bump creates a new row and never mutates the old one's chartConfigVersion", async () => {
  const { screenshot: v2 } = await tradeScreenshotsRepository.requestOrRetryScreenshot({
    setupId, tradeId: null, tradeSource: null, type: "PRE_TRADE", marketSnapshotId, chartConfigVersion: "2.0.0",
  });
  expect(v2.id).not.toBe(preTradeScreenshotId);
  const original = await tradeScreenshotsRepository.getScreenshot(preTradeScreenshotId);
  expect(original?.chartConfigVersion).toBe("1.0.0");
});
```

- [ ] **Step 3: Idempotency tests — same request twice, concurrent requests**

```typescript
it("requesting the same PRE_TRADE screenshot twice returns the same row, never a duplicate", async () => {
  const first = await tradeScreenshotsRepository.requestOrRetryScreenshot(requestInput);
  const second = await tradeScreenshotsRepository.requestOrRetryScreenshot(requestInput);
  expect(second.screenshot.id).toBe(first.screenshot.id);
  expect(second.alreadyInFlight).toBe(true);
  const rows = await prisma.tradeScreenshot.findMany({ where: { setupId: requestInput.setupId } });
  expect(rows).toHaveLength(1);
});

it("two concurrent requests for the same screenshot never create two rows", async () => {
  const [a, b] = await Promise.all([
    tradeScreenshotsRepository.requestOrRetryScreenshot(requestInput),
    tradeScreenshotsRepository.requestOrRetryScreenshot(requestInput),
  ]);
  expect(a.screenshot.id).toBe(b.screenshot.id);
  const rows = await prisma.tradeScreenshot.findMany({ where: { setupId: requestInput.setupId } });
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 4: Run all new tests against a live database**

Run: `pnpm infra:up && pnpm --filter @trading-copilot/database test && pnpm --filter @trading-copilot/dashboard test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app/internal/render/setup/route-boundaries.test.ts packages/database/src/screenshot-immutability.integration.test.ts
git commit -m "test: prove anti-look-ahead, immutability, and idempotency guarantees end to end"
```

---

## Task 13: Dashboard integration

**Files:**
- Modify: `apps/dashboard/src/app/live-setups/LiveSetupsClient.tsx` — a "Screenshot" column with status badge/thumbnail link
- Modify: `apps/dashboard/src/app/setups/[id]/page.tsx` — a screenshots card (status, `chartConfigVersion`, `renderedAt`, full image, failure message + admin retry button)
- Modify: `apps/dashboard/src/app/trades/[id]/page.tsx` — the same for POST_TRADE (check this page currently exists and its structure — mirror `setups/[id]/page.tsx`'s layout conventions)
- Create: `apps/dashboard/src/components/ScreenshotCard.tsx` — shared between both detail pages
- Modify: `apps/dashboard/src/lib/api.ts` — `getSetupScreenshots`, `getTradeScreenshots`, `requestPreTradeScreenshot`, `requestPostTradeScreenshot`

**Interfaces:**
- `ScreenshotCard` props: `{ screenshots: TradeScreenshot[]; onRetry: (screenshotId: string) => void }`.

- [ ] **Step 1: Implement `ScreenshotCard`**

For each screenshot: show `type`, a `StatusBadge`-style pill for `status` (reuse `apps/dashboard/src/components/StatusBadge.tsx`'s existing pattern — add a `ScreenshotStatusBadge` there rather than inventing a new component family), `chartConfigVersion`, `renderedAt` (formatted via the existing `formatDateTime`), and:
  - `READY` → an `<img src={`${NEXT_PUBLIC_API_BASE_URL}/screenshots/${id}/image`} />`, clickable to open full-size.
  - `FAILED` → the `failureCode`/`failureMessage` shown plainly in an `error-banner` (matching existing error-banner class usage elsewhere in this codebase), plus a "Retry" button calling `onRetry(screenshot.id)` — never hide a failure.
  - `REQUESTED`/`GENERATING` → a simple "Generating…" state. No polling and no new WebSocket event type for screenshots in this milestone — reloading the setup/trade detail page after generation completes is acceptable, matching how the rest of this dashboard already treats state that isn't wired to the realtime channel.

- [ ] **Step 2: Wire retry to the existing POST endpoints**

`onRetry` calls `requestPreTradeScreenshot(setupId)` or `requestPostTradeScreenshot(tradeId)` from `lib/api.ts` (both are already idempotent-safe to call again per Task 5/10 — a `FAILED` row is reset to `REQUESTED` and re-enqueued, a `READY` row is returned unchanged with `alreadyInFlight: true` and never re-enqueued).

- [ ] **Step 3: Add the `/live-setups` thumbnail column**

In `LiveSetupsClient.tsx`, add a `Screenshot` column showing a small `<img>` thumbnail when a `READY` PRE_TRADE screenshot exists for that setup (fetch lazily per-row the same way `ensureSnapshot` already lazily fetches `MarketSnapshot`s in this file — mirror that exact pattern for screenshots instead of adding a second different caching strategy), or a compact status badge otherwise.

- [ ] **Step 4: Manual smoke test in a browser**

With `pnpm infra:up && pnpm dev` running (and Task 9's Playwright/chromium installed), fire a real webhook fixture (`fixtures/tradingview/valid-long.json`), transition the resulting Setup to `READY` via `PATCH /setups/:id/status`, wait for the worker to process the screenshot job, then open `/live-setups` and `/setups/:id` and visually confirm the thumbnail and full screenshot render correctly.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/ScreenshotCard.tsx apps/dashboard/src/components/StatusBadge.tsx apps/dashboard/src/app/live-setups apps/dashboard/src/app/setups apps/dashboard/src/app/trades apps/dashboard/src/lib/api.ts
git commit -m "feat: display screenshot status/thumbnails/failures across the dashboard"
```

---

## Task 14: Screenshot subsystem health

**Files:**
- Modify: `apps/api/src/health/health.service.ts`

**Interfaces:**
- Extends `HealthStatus` with `screenshotGeneration: { status: "HEALTHY" | "DEGRADED" | "UNKNOWN"; lastSuccessfulScreenshotAt: string | null; recentFailureCount: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
it("reports screenshot generation health from real TradeScreenshot rows, never hardcoded HEALTHY", async () => {
  vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
  vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);
  const result = await new HealthService().check();
  expect(result.screenshotGeneration.status).toBe("UNKNOWN");
});
```

- [ ] **Step 2: Add the two small indexed repository queries**

In `packages/database/src/repositories/trade-screenshots.ts`, add `findMostRecentReadyScreenshot(): Promise<TradeScreenshot | null>` (`orderBy: { renderedAt: "desc" }, where: { status: "READY" }, take: 1` — backed by the existing `@@index([status])`) and `countRecentFailedScreenshots(sinceMinutesAgo: number): Promise<number>` (`count({ where: { status: "FAILED", updatedAt: { gte: cutoff } } })`).

- [ ] **Step 3: Extend `HealthService`**

```typescript
private async checkScreenshotGeneration(): Promise<ScreenshotGenerationHealth> {
  try {
    const [mostRecentReady, recentFailureCount] = await Promise.all([
      tradeScreenshotsRepository.findMostRecentReadyScreenshot(),
      tradeScreenshotsRepository.countRecentFailedScreenshots(60),
    ]);

    if (!mostRecentReady && recentFailureCount === 0) {
      return { status: "UNKNOWN", lastSuccessfulScreenshotAt: null, recentFailureCount: 0 };
    }

    return {
      status: recentFailureCount > 0 ? "DEGRADED" : "HEALTHY",
      lastSuccessfulScreenshotAt: mostRecentReady?.renderedAt?.toISOString() ?? null,
      recentFailureCount,
    };
  } catch {
    return { status: "UNKNOWN", lastSuccessfulScreenshotAt: null, recentFailureCount: 0 };
  }
}
```

Fold it into `check()`'s `Promise.all` and overall `status` the same way `tradingViewIngestion` already is — `DEGRADED` screenshot health degrades the overall status; `UNKNOWN` does not.

- [ ] **Step 4: Run tests, commit**

Run: `pnpm --filter @trading-copilot/api test && pnpm --filter @trading-copilot/database test`

```bash
git add apps/api/src/health packages/database/src/repositories/trade-screenshots.ts
git commit -m "feat: extend /health with screenshot subsystem status"
```

---

## Task 15: Documentation

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/screenshot-design.md`, `docs/trade-journal-design.md`, `docs/roadmap.md`, `docs/implementation-status.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Rewrite `docs/screenshot-design.md`** to describe what was actually built (it currently says "Out of scope for Milestone 1" and describes intent only): the real schema, the cutoff rule and which timestamp is authoritative for each screenshot type, the render-ready contract, `chartConfigVersion`, storage layout, and failure codes.
- [ ] **Step 2: Update `docs/trade-journal-design.md`**'s "Screenshots" section to point at the now-real pipeline instead of "No renderer/capture pipeline exists yet."
- [ ] **Step 3: Update `docs/architecture.md`** — add `packages/screenshot-storage` to the packages list and dependency diagram; note `apps/dashboard` now also serves two internal-only render routes consumed by `apps/worker`, not by end users.
- [ ] **Step 4: Update `docs/roadmap.md`** — mark Milestone 5 complete, matching the exact phrasing style used for Milestones 1–3.
- [ ] **Step 5: Update `docs/implementation-status.md`** — add a "Milestone 5 — Completed" section following the exact structure of the existing Milestone 1/2/3 sections (bulleted by package/app, ending with a "Final review pass" line once Task 16 below has run).
- [ ] **Step 6: Update `README.md`**'s quickstart if it documents `pnpm dev`'s app list or manual test steps, to mention Playwright's `chromium` browser install requirement (`pnpm --filter @trading-copilot/worker exec playwright install chromium`).
- [ ] **Step 7: Commit**

```bash
git add README.md docs/architecture.md docs/screenshot-design.md docs/trade-journal-design.md docs/roadmap.md docs/implementation-status.md
git commit -m "docs: document the Milestone 5 screenshot generation pipeline"
```

---

## Task 16: Final quality gates and real Playwright verification

**Files:** None (verification only).

- [ ] **Step 1: Run the full quality gate suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass.

- [ ] **Step 2: Run the full local manual end-to-end test**

Follow the 24-step procedure in the milestone brief's "LOCAL MANUAL END-TO-END TEST" section verbatim: start infra, start apps, fire a real webhook fixture, drive the Setup to `READY`, confirm the screenshot job queues and a real Playwright browser opens the renderer, confirm the PNG is stored and the row reaches `READY`, confirm `SCREENSHOT_CREATED` in the journal, inspect the thumbnail and full screenshot in the dashboard, confirm a known future candle never appears, re-request the same screenshot and confirm no duplicate, then (if closed-trade support is exercised) close the trade, generate POST_TRADE, and confirm PRE_TRADE is untouched. This must be a **real** Playwright run against the actual local application, not mocks (per the milestone brief's quality gates).

- [ ] **Step 3: Dispatch review subagents**

Dispatch, in this order (each reads the diff produced by Tasks 1–15):
- `system-architect` — screenshot architecture, module boundaries, historical-data boundaries.
- `research-methodologist` — anti-look-ahead audit (re-verify Task 2/2a/12's guarantees independently).
- `journal-analyst` — historical immutability, journal completeness.
- `quality-reviewer` — final correctness pass (financial precision, duplicate logic, test coverage, unsafe input, TypeScript, architecture).

Resolve every BLOCKER/HIGH finding before proceeding; re-run Step 1 after each fix.

- [ ] **Step 4: Answer the "Final Review Questions" from the milestone brief explicitly, in writing, in the completion report** — each of the 7 questions, with a one-line answer and, where relevant, a pointer to the exact test that proves it (e.g. "Q1: No — `getCandlesUpToTimestamp`'s `WHERE timestamp <= cutoff` is the only candle-fetching path a render route can reach; see Task 2a's integration test and Task 12's static-analysis test.").

- [ ] **Step 5: Update `docs/implementation-status.md`'s "Milestone 5 — Completed" section** with the final review pass outcome (mirroring the exact phrasing style of the Milestone 1/2/3 "Final review pass" lines), then commit.

```bash
git add docs/implementation-status.md
git commit -m "docs: close out Milestone 5 with final review pass results"
```

- [ ] **Step 6: Report per the milestone brief's "FINAL REPORT" 21-point structure** to the user, and explicitly recommend Milestone 6 (AI Research Agent) as next, per `docs/roadmap.md` — without starting it.
