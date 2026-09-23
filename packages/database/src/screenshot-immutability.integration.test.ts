import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { prisma } from "./client";
import * as instrumentsRepository from "./repositories/instruments";
import * as journalTradesRepository from "./repositories/journal-trades";
import * as marketSnapshotsRepository from "./repositories/market-snapshots";
import * as setupsRepository from "./repositories/setups";
import {
  getScreenshot,
  markScreenshotGenerating,
  markScreenshotReady,
  requestOrRetryScreenshot,
  type RequestScreenshotInput,
} from "./repositories/trade-screenshots";

const CHART_CONFIG_VERSION = "1.0.0";

/**
 * Task 12 ("prove it" task for Milestone 5, see
 * .superpowers/sdd/2026-09-23-milestone-5-screenshot-generation/task-12-brief.md):
 * end-to-end proof, against a real Postgres database, that a Setup's
 * PRE_TRADE TradeScreenshot is genuinely immutable once READY, and that
 * requestOrRetryScreenshot's idempotency guarantee holds under real
 * concurrency. Tasks 1-11 already built these guarantees (in particular the
 * `updateMany`-based atomic guards in trade-screenshots.ts, which replaced a
 * read-then-check-then-update pattern that had a real, reproduced
 * concurrency bug) — this file exists to verify they actually hold rather
 * than assume it. Mirrors this codebase's convention for transaction-heavy
 * repositories (journal.integration.test.ts, webhook-ingestion.integration.
 * test.ts, repositories/trade-screenshots.test.ts): live Postgres, gated on
 * DATABASE_URL, requires the Milestone 1 seed (`pnpm db:seed`).
 */
describe.skipIf(!process.env.DATABASE_URL)("screenshot immutability and idempotency (live Postgres)", () => {
  async function seededFixtures() {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
    if (!instrument) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
    if (!strategy) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    const strategyVersion = await prisma.strategyVersion.findUnique({
      where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
    });
    if (!strategyVersion) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    return { instrument, strategy, strategyVersion };
  }

  /**
   * A fresh MarketSnapshot + READY Setup per test, so each test's
   * (setupId, type, chartConfigVersion) idempotency key is unique and tests
   * never collide on each other's rows via the @@unique constraints.
   */
  async function freshReadySetup() {
    const { instrument, strategy, strategyVersion } = await seededFixtures();

    const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: instrument.id,
      timestamp: new Date(),
      timeframe: "1h",
      metadata: { test: "screenshot-immutability" },
    });

    let setup = await setupsRepository.createSetup({
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      marketSnapshotId: snapshot.id,
      direction: "LONG",
      source: "MANUAL_TEST",
      plannedEntry: new Decimal("100"),
      plannedStop: new Decimal("95"),
      plannedTarget1: new Decimal("110"),
      metadata: { test: "screenshot-immutability" },
    });
    setup = await setupsRepository.transitionSetupStatus(setup.id, { status: "PREPARE" });
    setup = await setupsRepository.transitionSetupStatus(setup.id, { status: "READY" });

    return { instrument, strategy, strategyVersion, snapshot, setup };
  }

  async function readyPreTradeScreenshot(setupId: string, snapshotId: string, chartConfigVersion: string) {
    const requested = await requestOrRetryScreenshot({
      setupId,
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: snapshotId,
      chartConfigVersion,
    });
    await markScreenshotGenerating(requested.screenshot.id);
    const ready = await markScreenshotReady(requested.screenshot.id, {
      storageProvider: "LOCAL_DISK",
      storageKey: `screenshots/${requested.screenshot.id}.png`,
      mimeType: "image/png",
      width: 1440,
      height: 900,
      renderedAt: new Date(),
    });
    return ready;
  }

  it("leaves a Setup's PRE_TRADE TradeScreenshot completely unchanged after its trade closes", async () => {
    const { instrument, strategy, strategyVersion, snapshot, setup } = await freshReadySetup();
    const preTradeScreenshot = await readyPreTradeScreenshot(setup.id, snapshot.id, CHART_CONFIG_VERSION);

    const before = await getScreenshot(preTradeScreenshot.id);
    expect(before?.status).toBe("READY");

    const trade = await journalTradesRepository.createJournalTrade({
      setupId: setup.id,
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      direction: "LONG",
      plannedEntry: new Decimal("100"),
      plannedStop: new Decimal("95"),
      plannedTarget1: new Decimal("110"),
      plannedRisk: new Decimal("5"),
      executionMode: "PAPER",
    });

    await journalTradesRepository.recordJournalTradeEntry(trade.id, {
      actualEntry: new Decimal("100.25"),
      entryTimestamp: new Date(),
      quantity: 1,
      estimatedFees: new Decimal("2.5"),
      estimatedSlippage: new Decimal("1"),
    });

    await journalTradesRepository.closeJournalTrade(trade.id, {
      actualExit: new Decimal("109.75"),
      exitTimestamp: new Date(),
      actualFees: new Decimal("2.5"),
      actualSlippage: new Decimal("1"),
      mfe: new Decimal("10"),
      mae: new Decimal("1"),
    });

    const after = await getScreenshot(preTradeScreenshot.id);
    expect(after).toEqual(before);
  });

  it("a POST_TRADE screenshot never overwrites the PRE_TRADE row for the same Setup", async () => {
    const { instrument, strategy, strategyVersion, snapshot, setup } = await freshReadySetup();
    const preTradeScreenshot = await readyPreTradeScreenshot(setup.id, snapshot.id, CHART_CONFIG_VERSION);

    const trade = await journalTradesRepository.createJournalTrade({
      setupId: setup.id,
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      direction: "LONG",
      plannedEntry: new Decimal("100"),
      plannedStop: new Decimal("95"),
      plannedTarget1: new Decimal("110"),
      plannedRisk: new Decimal("5"),
      executionMode: "PAPER",
    });

    const { screenshot: postTrade } = await requestOrRetryScreenshot({
      setupId: null,
      tradeId: trade.id,
      tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE",
      marketSnapshotId: null,
      chartConfigVersion: CHART_CONFIG_VERSION,
    });

    expect(postTrade.id).not.toBe(preTradeScreenshot.id);

    const preTradeStillThere = await getScreenshot(preTradeScreenshot.id);
    expect(preTradeStillThere?.status).toBe("READY");
    expect(preTradeStillThere?.type).toBe("PRE_TRADE");
    expect(preTradeStillThere?.storageKey).toBe(preTradeScreenshot.storageKey);

    // Both rows genuinely coexist — a POST_TRADE row for the trade, a
    // PRE_TRADE row for the setup, never collapsed into one.
    const rows = await prisma.tradeScreenshot.findMany({
      where: { OR: [{ id: preTradeScreenshot.id }, { id: postTrade.id }] },
    });
    expect(rows).toHaveLength(2);
  });

  it("a chartConfigVersion bump creates a new row and never mutates the old row's chartConfigVersion", async () => {
    const { snapshot, setup } = await freshReadySetup();
    const preTradeScreenshot = await readyPreTradeScreenshot(setup.id, snapshot.id, "1.0.0");
    expect(preTradeScreenshot.chartConfigVersion).toBe("1.0.0");

    const { screenshot: v2 } = await requestOrRetryScreenshot({
      setupId: setup.id,
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: snapshot.id,
      chartConfigVersion: "2.0.0",
    });

    expect(v2.id).not.toBe(preTradeScreenshot.id);
    expect(v2.chartConfigVersion).toBe("2.0.0");

    // The critical assertion: the OLD row's own chartConfigVersion field
    // (not merely "a new row exists") is untouched — still "1.0.0", never
    // bumped in place to "2.0.0".
    const original = await getScreenshot(preTradeScreenshot.id);
    expect(original?.chartConfigVersion).toBe("1.0.0");
    expect(original?.status).toBe("READY");
    expect(original?.storageKey).toBe(preTradeScreenshot.storageKey);

    const rows = await prisma.tradeScreenshot.findMany({ where: { setupId: setup.id } });
    expect(rows.map((r) => r.chartConfigVersion).sort()).toEqual(["1.0.0", "2.0.0"]);
  });

  it("requesting the same PRE_TRADE screenshot twice returns the same row, never a duplicate", async () => {
    const { snapshot, setup } = await freshReadySetup();
    const requestInput: RequestScreenshotInput = {
      setupId: setup.id,
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: snapshot.id,
      chartConfigVersion: CHART_CONFIG_VERSION,
    };

    const first = await requestOrRetryScreenshot(requestInput);
    const second = await requestOrRetryScreenshot(requestInput);

    expect(second.screenshot.id).toBe(first.screenshot.id);
    expect(second.alreadyInFlight).toBe(true);

    const rows = await prisma.tradeScreenshot.findMany({ where: { setupId: requestInput.setupId! } });
    expect(rows).toHaveLength(1);
  });

  it("two genuinely concurrent requests for the same screenshot never create two rows", async () => {
    const { snapshot, setup } = await freshReadySetup();
    const requestInput: RequestScreenshotInput = {
      setupId: setup.id,
      tradeId: null,
      tradeSource: null,
      type: "PRE_TRADE",
      marketSnapshotId: snapshot.id,
      chartConfigVersion: CHART_CONFIG_VERSION,
    };

    // Real concurrency: both calls are started together via Promise.all
    // (not "await the first, then await the second") and race against the
    // real Postgres @@unique constraint on (setupId, type,
    // chartConfigVersion) inside requestOrRetryScreenshot's transaction.
    const [a, b] = await Promise.all([
      requestOrRetryScreenshot(requestInput),
      requestOrRetryScreenshot(requestInput),
    ]);

    expect(a.screenshot.id).toBe(b.screenshot.id);
    const flags = [a.alreadyInFlight, b.alreadyInFlight].sort();
    expect(flags).toEqual([false, true]);

    const rows = await prisma.tradeScreenshot.findMany({ where: { setupId: requestInput.setupId! } });
    expect(rows).toHaveLength(1);
  });

  /**
   * Bundled fix from Task 12 review: the four tests above only ever
   * exercise the setup-keyed @@unique([setupId, type, chartConfigVersion])
   * constraint. requestOrRetryScreenshot has a second, independent
   * idempotency path keyed on @@unique([tradeId, tradeSource, type,
   * chartConfigVersion]) (see findByIdempotencyKey's tradeId branch and
   * the POST_TRADE isUniqueConstraintViolation field list in
   * trade-screenshots.ts) that was otherwise never exercised by this file.
   * No JournalTrade row is required - tradeId/tradeSource are plain
   * columns on TradeScreenshot with no foreign key to JournalTrade (see
   * schema.prisma), matching the existing convention in
   * repositories/trade-screenshots.test.ts's own postTradeInput().
   */
  it("the trade-keyed idempotency key is genuinely exercised: same-request-twice and real concurrent requests both collapse to one row", async () => {
    const requestInput: RequestScreenshotInput = {
      setupId: null,
      tradeId: `trade-${randomUUID()}`,
      tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE",
      marketSnapshotId: null,
      chartConfigVersion: CHART_CONFIG_VERSION,
    };

    // Same request twice, sequentially.
    const first = await requestOrRetryScreenshot(requestInput);
    const second = await requestOrRetryScreenshot(requestInput);
    expect(second.screenshot.id).toBe(first.screenshot.id);
    expect(second.alreadyInFlight).toBe(true);

    const rowsAfterSequential = await prisma.tradeScreenshot.findMany({
      where: { tradeId: requestInput.tradeId!, tradeSource: requestInput.tradeSource! },
    });
    expect(rowsAfterSequential).toHaveLength(1);

    // A second, distinct trade-keyed request, this time raced for real via
    // Promise.all against the same real Postgres @@unique constraint on
    // (tradeId, tradeSource, type, chartConfigVersion).
    const concurrentInput: RequestScreenshotInput = {
      setupId: null,
      tradeId: `trade-${randomUUID()}`,
      tradeSource: "JOURNAL_TRADE",
      type: "POST_TRADE",
      marketSnapshotId: null,
      chartConfigVersion: CHART_CONFIG_VERSION,
    };
    const [a, b] = await Promise.all([
      requestOrRetryScreenshot(concurrentInput),
      requestOrRetryScreenshot(concurrentInput),
    ]);
    expect(a.screenshot.id).toBe(b.screenshot.id);
    const flags = [a.alreadyInFlight, b.alreadyInFlight].sort();
    expect(flags).toEqual([false, true]);

    const rowsAfterConcurrent = await prisma.tradeScreenshot.findMany({
      where: { tradeId: concurrentInput.tradeId!, tradeSource: concurrentInput.tradeSource! },
    });
    expect(rowsAfterConcurrent).toHaveLength(1);
  });
});
