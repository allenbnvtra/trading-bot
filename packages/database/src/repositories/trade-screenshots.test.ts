import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { prisma } from "../client";
import { NotFoundError, ScreenshotStateError, ScreenshotTargetError } from "../errors";
import * as instrumentsRepository from "./instruments";
import * as journalEventsRepository from "./journal-events";
import * as marketSnapshotsRepository from "./market-snapshots";
import * as setupsRepository from "./setups";
import {
  assertValidScreenshotTarget,
  getScreenshot,
  listScreenshotsForSetup,
  listScreenshotsForTrade,
  markScreenshotFailed,
  markScreenshotGenerating,
  markScreenshotReady,
  requestOrRetryScreenshot,
  type RequestScreenshotInput,
} from "./trade-screenshots";

const CHART_CONFIG_VERSION = "1.0.0";

function preTradeInput(overrides: Partial<RequestScreenshotInput> = {}): RequestScreenshotInput {
  return {
    setupId: `setup-${randomUUID()}`,
    tradeId: null,
    tradeSource: null,
    type: "PRE_TRADE",
    marketSnapshotId: null,
    chartConfigVersion: CHART_CONFIG_VERSION,
    ...overrides,
  };
}

function postTradeInput(overrides: Partial<RequestScreenshotInput> = {}): RequestScreenshotInput {
  return {
    setupId: null,
    tradeId: `trade-${randomUUID()}`,
    tradeSource: "JOURNAL_TRADE",
    type: "POST_TRADE",
    marketSnapshotId: null,
    chartConfigVersion: CHART_CONFIG_VERSION,
    ...overrides,
  };
}

/**
 * assertValidScreenshotTarget is pure (no Prisma involved) — this is an
 * exhaustive unit test of every malformed combination, mirroring
 * setups.test.ts's exhaustive-matrix style for isAllowedSetupTransition.
 * This is what actually proves the type/setupId/tradeId consistency
 * validation rejects a malformed combination, rather than merely happening
 * to work for well-formed inputs (Task 1 review carry-forward note).
 */
describe("assertValidScreenshotTarget", () => {
  it("accepts a well-formed setupId-targeted PRE_TRADE input", () => {
    expect(() => assertValidScreenshotTarget(preTradeInput())).not.toThrow();
  });

  it("accepts a well-formed trade-targeted POST_TRADE input", () => {
    expect(() => assertValidScreenshotTarget(postTradeInput())).not.toThrow();
  });

  it("rejects setupId set with type POST_TRADE (the malformed row from the Task 1 review note)", () => {
    expect(() =>
      assertValidScreenshotTarget(preTradeInput({ type: "POST_TRADE" })),
    ).toThrow(ScreenshotTargetError);
  });

  it("rejects tradeId/tradeSource set with type PRE_TRADE", () => {
    expect(() =>
      assertValidScreenshotTarget(postTradeInput({ type: "PRE_TRADE" })),
    ).toThrow(ScreenshotTargetError);
  });

  it("rejects neither setupId nor tradeId/tradeSource provided", () => {
    expect(() =>
      assertValidScreenshotTarget({
        setupId: null,
        tradeId: null,
        tradeSource: null,
        type: "PRE_TRADE",
        marketSnapshotId: null,
        chartConfigVersion: CHART_CONFIG_VERSION,
      }),
    ).toThrow(ScreenshotTargetError);
  });

  it("rejects both setupId and tradeId/tradeSource provided at once", () => {
    expect(() =>
      assertValidScreenshotTarget({
        setupId: `setup-${randomUUID()}`,
        tradeId: `trade-${randomUUID()}`,
        tradeSource: "JOURNAL_TRADE",
        type: "PRE_TRADE",
        marketSnapshotId: null,
        chartConfigVersion: CHART_CONFIG_VERSION,
      }),
    ).toThrow(ScreenshotTargetError);
  });

  it("rejects a half-set trade target (tradeId without tradeSource)", () => {
    expect(() =>
      assertValidScreenshotTarget(
        postTradeInput({ tradeSource: null }),
      ),
    ).toThrow(ScreenshotTargetError);
  });

  it("rejects a half-set trade target (tradeSource without tradeId)", () => {
    expect(() =>
      assertValidScreenshotTarget(postTradeInput({ tradeId: null })),
    ).toThrow(ScreenshotTargetError);
  });
});

/**
 * Everything below exercises real transaction/constraint behavior
 * (prisma.$transaction, the two @@unique constraints, P2002 handling) and is
 * therefore run against a real Postgres database rather than a mocked
 * PrismaClient — mocking `$transaction` here would not exercise the actual
 * race condition this repository exists to close, and this codebase's own
 * convention for transaction-heavy repositories (inbound-webhook-events.ts,
 * journal-trades.ts) is to test them live (see
 * webhook-ingestion.integration.test.ts, journal.integration.test.ts).
 * Requires DATABASE_URL and the Milestone 1 seed (`pnpm db:seed`).
 */
describe.skipIf(!process.env.DATABASE_URL)("trade-screenshots repository (live Postgres)", () => {
  async function seededSetup() {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
    if (!instrument) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
    if (!strategy) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    const strategyVersion = await prisma.strategyVersion.findUnique({
      where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
    });
    if (!strategyVersion) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: instrument.id,
      timestamp: new Date(),
      timeframe: "1h",
      metadata: { test: "trade-screenshots" },
    });

    const setup = await setupsRepository.createSetup({
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      marketSnapshotId: snapshot.id,
      direction: "LONG",
      source: "MANUAL_TEST",
      plannedEntry: new Decimal("100"),
      plannedStop: new Decimal("95"),
      plannedTarget1: new Decimal("110"),
      metadata: { test: "trade-screenshots" },
    });

    return { instrument, strategy, strategyVersion, snapshot, setup };
  }

  it("creates a new REQUESTED row and emits SCREENSHOT_REQUESTED when none exists", async () => {
    const { setup, snapshot } = await seededSetup();

    const result = await requestOrRetryScreenshot(
      preTradeInput({ setupId: setup.id, marketSnapshotId: snapshot.id }),
    );

    expect(result.alreadyInFlight).toBe(false);
    expect(result.screenshot.status).toBe("REQUESTED");
    expect(result.screenshot.setupId).toBe(setup.id);

    const events = await journalEventsRepository.listJournalEvents({ entityId: result.screenshot.id });
    expect(events.map((e) => e.eventType)).toEqual(["SCREENSHOT_REQUESTED"]);
  });

  it("is idempotent: a second request with the same key returns the existing row, alreadyInFlight true, no duplicate", async () => {
    const input = postTradeInput();

    const first = await requestOrRetryScreenshot(input);
    const second = await requestOrRetryScreenshot(input);

    expect(first.alreadyInFlight).toBe(false);
    expect(second.alreadyInFlight).toBe(true);
    expect(second.screenshot.id).toBe(first.screenshot.id);

    const rows = await prisma.tradeScreenshot.findMany({
      where: { tradeId: input.tradeId!, tradeSource: input.tradeSource! },
    });
    expect(rows).toHaveLength(1);
  });

  it(
    "requestOrRetryScreenshot is idempotent under genuine concurrent requests for the identical key " +
      "(real Promise.all, real Postgres) — exactly one row is ever created",
    async () => {
      const input = postTradeInput();

      const [resultA, resultB] = await Promise.all([
        requestOrRetryScreenshot(input),
        requestOrRetryScreenshot(input),
      ]);

      const rows = await prisma.tradeScreenshot.findMany({
        where: { tradeId: input.tradeId!, tradeSource: input.tradeSource! },
      });
      expect(rows).toHaveLength(1);
      expect(resultA.screenshot.id).toBe(resultB.screenshot.id);
      expect(resultA.screenshot.id).toBe(rows[0]!.id);

      // Exactly one of the two calls created the row; the other observed it.
      const flags = [resultA.alreadyInFlight, resultB.alreadyInFlight].sort();
      expect(flags).toEqual([false, true]);

      // No duplicate SCREENSHOT_REQUESTED — only the winner's create emitted one.
      const events = await journalEventsRepository.listJournalEvents({ entityId: rows[0]!.id });
      expect(events.map((e) => e.eventType)).toEqual(["SCREENSHOT_REQUESTED"]);
    },
  );

  it("resets a FAILED row to REQUESTED on retry (the only mutation ever applied to a non-terminal row), never touching a READY row this way", async () => {
    const input = postTradeInput();

    const created = await requestOrRetryScreenshot(input);
    await markScreenshotGenerating(created.screenshot.id);
    const failed = await markScreenshotFailed(created.screenshot.id, {
      failureCode: "RENDER_TIMEOUT",
      failureMessage: "chart renderer timed out",
    });
    expect(failed.status).toBe("FAILED");

    const retried = await requestOrRetryScreenshot(input);
    expect(retried.alreadyInFlight).toBe(false);
    expect(retried.screenshot.id).toBe(created.screenshot.id);
    expect(retried.screenshot.status).toBe("REQUESTED");
    expect(retried.screenshot.failureCode).toBeNull();
    expect(retried.screenshot.failureMessage).toBeNull();

    const rows = await prisma.tradeScreenshot.findMany({
      where: { tradeId: input.tradeId!, tradeSource: input.tradeSource! },
    });
    expect(rows).toHaveLength(1);
  });

  it("markScreenshotGenerating: REQUESTED -> GENERATING, and throws ScreenshotStateError from any other state", async () => {
    const created = await requestOrRetryScreenshot(postTradeInput());

    const generating = await markScreenshotGenerating(created.screenshot.id);
    expect(generating.status).toBe("GENERATING");

    await expect(markScreenshotGenerating(created.screenshot.id)).rejects.toThrow(ScreenshotStateError);
  });

  it("markScreenshotGenerating throws NotFoundError for an unknown id", async () => {
    await expect(markScreenshotGenerating(randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("markScreenshotReady: GENERATING -> READY, and genuinely throws (never silently no-ops) when called again on the now-READY row", async () => {
    const created = await requestOrRetryScreenshot(postTradeInput());
    await markScreenshotGenerating(created.screenshot.id);

    const readyInput = {
      storageProvider: "LOCAL_DISK",
      storageKey: `screenshots/${created.screenshot.id}.png`,
      mimeType: "image/png",
      width: 1440,
      height: 900,
      renderedAt: new Date(),
    };

    const ready = await markScreenshotReady(created.screenshot.id, readyInput);
    expect(ready.status).toBe("READY");
    expect(ready.storageKey).toBe(readyInput.storageKey);

    // The critical immutability assertion: a second markScreenshotReady call
    // on the same (now READY) row must throw, not overwrite the row.
    await expect(
      markScreenshotReady(created.screenshot.id, {
        ...readyInput,
        storageKey: "screenshots/attempted-overwrite.png",
      }),
    ).rejects.toThrow(ScreenshotStateError);

    // Prove the row itself was never overwritten by the rejected second call.
    const row = await prisma.tradeScreenshot.findUnique({ where: { id: created.screenshot.id } });
    expect(row?.storageKey).toBe(readyInput.storageKey);

    const events = await journalEventsRepository.listJournalEvents({ entityId: created.screenshot.id });
    expect(events.map((e) => e.eventType)).toEqual([
      "SCREENSHOT_REQUESTED",
      "SCREENSHOT_GENERATION_STARTED",
      "SCREENSHOT_CREATED",
    ]);
  });

  it("markScreenshotReady also allows REQUESTED -> READY directly (skipping GENERATING)", async () => {
    const created = await requestOrRetryScreenshot(postTradeInput());
    const ready = await markScreenshotReady(created.screenshot.id, {
      storageProvider: "LOCAL_DISK",
      storageKey: `screenshots/${created.screenshot.id}.png`,
      mimeType: "image/png",
      width: 1440,
      height: 900,
      renderedAt: new Date(),
    });
    expect(ready.status).toBe("READY");
  });

  it("markScreenshotFailed: REQUESTED/GENERATING -> FAILED, and refuses to flip an already-READY row to FAILED", async () => {
    const created = await requestOrRetryScreenshot(postTradeInput());
    await markScreenshotGenerating(created.screenshot.id);
    const ready = await markScreenshotReady(created.screenshot.id, {
      storageProvider: "LOCAL_DISK",
      storageKey: `screenshots/${created.screenshot.id}.png`,
      mimeType: "image/png",
      width: 1440,
      height: 900,
      renderedAt: new Date(),
    });
    expect(ready.status).toBe("READY");

    await expect(
      markScreenshotFailed(created.screenshot.id, {
        failureCode: "RENDER_TIMEOUT",
        failureMessage: "should never apply to a READY row",
      }),
    ).rejects.toThrow(ScreenshotStateError);

    const row = await prisma.tradeScreenshot.findUnique({ where: { id: created.screenshot.id } });
    expect(row?.status).toBe("READY");
    expect(row?.failureCode).toBeNull();
  });

  it("getScreenshot / listScreenshotsForSetup / listScreenshotsForTrade return what was written", async () => {
    const { setup, snapshot } = await seededSetup();
    const created = await requestOrRetryScreenshot(
      preTradeInput({ setupId: setup.id, marketSnapshotId: snapshot.id }),
    );

    const fetched = await getScreenshot(created.screenshot.id);
    expect(fetched?.id).toBe(created.screenshot.id);

    const bySetup = await listScreenshotsForSetup(setup.id);
    expect(bySetup.map((s) => s.id)).toContain(created.screenshot.id);

    const tradeInput = postTradeInput();
    const tradeCreated = await requestOrRetryScreenshot(tradeInput);
    const byTrade = await listScreenshotsForTrade(tradeInput.tradeId!, tradeInput.tradeSource!);
    expect(byTrade.map((s) => s.id)).toEqual([tradeCreated.screenshot.id]);
  });

  it("getScreenshot returns null for an unknown id", async () => {
    expect(await getScreenshot(randomUUID())).toBeNull();
  });
});
