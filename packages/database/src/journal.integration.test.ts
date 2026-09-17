import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  calculatePositionSize,
  calculateRiskBudget,
  calculateRiskPerContract,
  calculateRiskReward,
  calculateStopDistancePoints,
  calculateStopDistanceTicks,
} from "@trading-copilot/risk-engine";
import { prisma } from "./client";
import { toDb8 } from "./test-support/decimal";
import { getNormalizedTrades } from "./analytics-adapter";
import { NotFoundError, SetupTransitionError } from "./errors";
import * as backtestsRepository from "./repositories/backtests";
import * as instrumentsRepository from "./repositories/instruments";
import * as journalEventsRepository from "./repositories/journal-events";
import * as journalTradesRepository from "./repositories/journal-trades";
import * as marketSnapshotsRepository from "./repositories/market-snapshots";
import * as postTradeAnalysesRepository from "./repositories/post-trade-analyses";
import * as riskCalculationsRepository from "./repositories/risk-calculations";
import * as setupsRepository from "./repositories/setups";
import * as strategiesRepository from "./repositories/strategies";

/**
 * End-to-end pipeline test against a real Postgres database, exercising
 * every Milestone 2 repository together with the Milestone 1
 * BacktestTrade -> NormalizedTrade path. Requires DATABASE_URL (the
 * project's docker-compose Postgres, `pnpm infra:up`) and the Milestone 1
 * seed (`pnpm db:seed`) to have been run at least once, since it looks up
 * the seeded GENFUT1 instrument and ema-trend-pullback strategy version
 * rather than fabricating its own.
 */
describe.skipIf(!process.env.DATABASE_URL)("journal pipeline (live Postgres)", () => {
  it("runs the full Setup -> RiskCalculation -> JournalTrade -> timeline -> normalized-trades pipeline", async () => {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange(
      "GENFUT1",
      "SIM-FUT",
    );
    expect(instrument, "expected the Milestone 1 seed to have run (pnpm db:seed)").not.toBeNull();
    if (!instrument) return;

    const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
    expect(strategy).not.toBeNull();
    if (!strategy) return;

    const strategyVersion = await prisma.strategyVersion.findUnique({
      where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
    });
    expect(strategyVersion).not.toBeNull();
    if (!strategyVersion) return;

    // --- 1. MarketSnapshot + Setup (WATCH) ---------------------------------

    const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: instrument.id,
      timestamp: new Date("2024-03-01T08:00:00.000Z"),
      timeframe: "1h",
      trend1h: "UP",
      atr: new Decimal("20"),
      session: "RTH",
      metadata: { integrationTest: true },
    });

    const plannedEntry = new Decimal("5200");
    const plannedStop = new Decimal("5185");
    const plannedTarget1 = new Decimal("5230"); // 2:1 reward:risk

    let setup = await setupsRepository.createSetup({
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      marketSnapshotId: snapshot.id,
      direction: "LONG",
      source: "MANUAL_TEST",
      plannedEntry,
      plannedStop,
      plannedTarget1,
      metadata: { integrationTest: true },
    });
    expect(setup.status).toBe("WATCH");

    // --- 2. Invalid transitions must throw ---------------------------------

    // Same-status no-op: not in the allowed-transition matrix for any status.
    await expect(setupsRepository.transitionSetupStatus(setup.id, { status: "WATCH" })).rejects.toThrow(
      SetupTransitionError,
    );

    // --- 3. WATCH -> PREPARE -> READY --------------------------------------

    setup = await setupsRepository.transitionSetupStatus(setup.id, { status: "PREPARE" });
    expect(setup.status).toBe("PREPARE");

    setup = await setupsRepository.transitionSetupStatus(setup.id, { status: "READY" });
    expect(setup.status).toBe("READY");

    // A transition attempted out of a terminal status must also throw.
    // (Verified independently via the exhaustive unit test in
    // setups.test.ts; re-checked here against the live DB using a
    // throwaway REJECTED setup so the main setup's lifecycle isn't
    // disturbed.)
    const throwawaySnapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: instrument.id,
      timestamp: new Date("2024-03-01T08:00:00.000Z"),
      timeframe: "1h",
      metadata: { integrationTest: true },
    });
    let throwawaySetup = await setupsRepository.createSetup({
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      marketSnapshotId: throwawaySnapshot.id,
      direction: "LONG",
      source: "MANUAL_TEST",
      plannedEntry,
      plannedStop,
      plannedTarget1,
      metadata: { integrationTest: true },
    });
    throwawaySetup = await setupsRepository.transitionSetupStatus(throwawaySetup.id, {
      status: "REJECTED",
    });
    expect(throwawaySetup.status).toBe("REJECTED");
    await expect(
      setupsRepository.transitionSetupStatus(throwawaySetup.id, { status: "READY" }),
    ).rejects.toThrow(SetupTransitionError);

    // --- 4. RiskCalculation, cross-checked against packages/risk-engine ----

    const accountEquity = new Decimal("100000");
    const riskPercentage = new Decimal("1");
    const slippageTicks = 2;

    const riskCalculation = await riskCalculationsRepository.createRiskCalculation(setup.id, {
      accountEquity,
      riskPercentage,
      slippageTicks,
    });

    const tickSize = new Decimal(instrument.tickSize.toString());
    const pointValue = new Decimal(instrument.pointValue.toString());
    const commissionPerContract = new Decimal(instrument.commissionPerContract.toString());

    const expectedStopDistancePoints = calculateStopDistancePoints(plannedEntry, plannedStop);
    const expectedStopDistanceTicks = calculateStopDistanceTicks(expectedStopDistancePoints, tickSize);
    const expectedRiskBudget = calculateRiskBudget(accountEquity, riskPercentage);
    const expectedSlippage = new Decimal(slippageTicks).times(tickSize).times(pointValue);
    const expectedRiskPerUnit = calculateRiskPerContract(
      expectedStopDistancePoints,
      pointValue,
      commissionPerContract,
      expectedSlippage,
    );
    const expectedQuantity = calculatePositionSize(expectedRiskBudget, expectedRiskPerUnit);
    const expectedTotalRisk = expectedRiskPerUnit.times(expectedQuantity);
    const expectedRiskReward = calculateRiskReward(plannedEntry, plannedStop, plannedTarget1);

    expect(toDb8(riskCalculation.stopDistancePoints)).toBe(toDb8(expectedStopDistancePoints));
    expect(toDb8(riskCalculation.stopDistanceTicks)).toBe(toDb8(expectedStopDistanceTicks));
    expect(toDb8(riskCalculation.riskBudget)).toBe(toDb8(expectedRiskBudget));
    expect(toDb8(riskCalculation.estimatedSlippage)).toBe(toDb8(expectedSlippage));
    expect(toDb8(riskCalculation.riskPerUnit)).toBe(toDb8(expectedRiskPerUnit));
    expect(riskCalculation.calculatedQuantity).toBe(expectedQuantity);
    expect(toDb8(riskCalculation.estimatedTotalRisk)).toBe(toDb8(expectedTotalRisk));
    expect(toDb8(riskCalculation.riskReward)).toBe(toDb8(expectedRiskReward));
    expect(riskCalculation.calculatedQuantity).toBeGreaterThan(0); // otherwise the trade below can't be entered meaningfully

    // --- 5. JournalTrade (PAPER): create, enter, close ---------------------

    let trade = await journalTradesRepository.createJournalTrade({
      setupId: setup.id,
      instrumentId: instrument.id,
      strategyId: strategy.id,
      strategyVersionId: strategyVersion.id,
      direction: "LONG",
      plannedEntry,
      plannedStop,
      plannedTarget1,
      plannedRisk: riskCalculation.estimatedTotalRisk,
      executionMode: "PAPER",
    });
    expect(trade.status).toBe("PLANNED");

    const actualEntry = new Decimal("5200.25");
    trade = await journalTradesRepository.recordJournalTradeEntry(trade.id, {
      actualEntry,
      entryTimestamp: new Date("2024-03-01T09:00:00.000Z"),
      quantity: riskCalculation.calculatedQuantity,
      estimatedFees: riskCalculation.estimatedCommission,
      estimatedSlippage: riskCalculation.estimatedSlippage,
    });
    expect(trade.status).toBe("OPEN");

    const actualExit = new Decimal("5229.75");
    const actualFees = riskCalculation.estimatedCommission;
    trade = await journalTradesRepository.closeJournalTrade(trade.id, {
      actualExit,
      exitTimestamp: new Date("2024-03-01T15:00:00.000Z"),
      actualFees,
      actualSlippage: riskCalculation.estimatedSlippage,
      mfe: new Decimal("32"),
      mae: new Decimal("4"),
    });
    expect(trade.status).toBe("CLOSED");

    const expectedGrossPnl = actualExit.minus(actualEntry).times(pointValue).times(riskCalculation.calculatedQuantity);
    const expectedNetPnl = expectedGrossPnl.minus(actualFees);
    const expectedRMultiple = expectedNetPnl.dividedBy(riskCalculation.estimatedTotalRisk);

    expect(trade.grossPnl).not.toBeNull();
    expect(trade.netPnl).not.toBeNull();
    expect(trade.rMultiple).not.toBeNull();
    expect(toDb8(trade.grossPnl!)).toBe(toDb8(expectedGrossPnl));
    expect(toDb8(trade.netPnl!)).toBe(toDb8(expectedNetPnl));
    expect(toDb8(trade.rMultiple!)).toBe(toDb8(expectedRMultiple));

    // --- 6. Setup timeline: correct chronological order and event types ----

    const timeline = await journalEventsRepository.getSetupTimeline(setup.id);
    expect(timeline.map((event) => event.eventType)).toEqual([
      "SETUP_CREATED",
      "SETUP_APPROVED", // the PREPARE transition emits no event by design; READY does
      "RISK_CALCULATED",
      "TRADE_READY",
      "TRADE_EXECUTED",
      "TRADE_CLOSED",
    ]);
    for (let i = 1; i < timeline.length; i += 1) {
      const current = timeline[i];
      const previous = timeline[i - 1];
      expect(current).toBeDefined();
      expect(previous).toBeDefined();
      expect(current!.timestamp.getTime()).toBeGreaterThanOrEqual(previous!.timestamp.getTime());
    }

    // --- 7. getNormalizedTrades: both sources appear in normalized form ----

    const backtestTrades = await prisma.backtestTrade.findMany({
      where: { strategyVersionId: strategyVersion.id },
      take: 1,
    });
    let referenceBacktestTradeId: string;
    if (backtestTrades[0]) {
      referenceBacktestTradeId = backtestTrades[0].id;
    } else {
      // Fall back to creating one via the Milestone 1 repository so this
      // assertion doesn't depend on a backtest having been run beforehand
      // in a fresh environment.
      const backtest = await backtestsRepository.createBacktest({
        strategyVersionId: strategyVersion.id,
        instrumentId: instrument.id,
        timeframe: "1h",
        startDate: new Date("2024-01-01T00:00:00.000Z"),
        endDate: new Date("2024-02-01T00:00:00.000Z"),
        assumptions: {
          commissionPerContract: "2.50",
          slippageTicks: 1,
          riskPercentage: "1",
          initialBalance: "10000",
        },
      });
      const created = await backtestsRepository.replaceBacktestTrades(backtest.id, [
        {
          strategyVersionId: strategyVersion.id,
          instrumentId: instrument.id,
          direction: "LONG",
          signalTimestamp: new Date("2024-01-05T00:00:00.000Z"),
          entryTimestamp: new Date("2024-01-05T01:00:00.000Z"),
          entryPrice: new Decimal("100"),
          stopPrice: new Decimal("98"),
          targetPrice: new Decimal("104"),
          exitTimestamp: new Date("2024-01-05T05:00:00.000Z"),
          exitPrice: new Decimal("104"),
          entryReason: "integration test fixture",
          exitReason: "TARGET",
          quantity: 1,
          grossPnl: new Decimal("4"),
          fees: new Decimal("1"),
          netPnl: new Decimal("3"),
          riskAmount: new Decimal("2"),
          rMultiple: new Decimal("1.5"),
          maximumFavorableExcursion: new Decimal("5"),
          maximumAdverseExcursion: new Decimal("1"),
        },
      ]);
      const createdTrade = created[0];
      if (!createdTrade) {
        throw new Error("expected replaceBacktestTrades to return the created trade");
      }
      referenceBacktestTradeId = createdTrade.id;
    }

    const normalized = await getNormalizedTrades({ strategyVersionId: strategyVersion.id });

    const normalizedJournalTrade = normalized.find(
      (n) => n.source === "JOURNAL" && n.id === trade.id,
    );
    expect(normalizedJournalTrade).toBeDefined();
    expect(toDb8(normalizedJournalTrade!.netPnl)).toBe(toDb8(expectedNetPnl));
    expect(toDb8(normalizedJournalTrade!.rMultiple!)).toBe(toDb8(expectedRMultiple));
    expect(normalizedJournalTrade?.executionMode).toBe("PAPER");

    const normalizedBacktestTrade = normalized.find(
      (n) => n.source === "BACKTEST" && n.id === referenceBacktestTradeId,
    );
    expect(normalizedBacktestTrade).toBeDefined();
    expect(normalizedBacktestTrade?.strategyId).toBe(strategy.id);
    expect(normalizedBacktestTrade?.executionMode).toBe("BACKTEST");
    expect(normalizedBacktestTrade?.slippage).toBeNull();
  });

  it("rejects a PostTradeAnalysis referencing a nonexistent trade instead of inserting with null correlation metadata", async () => {
    await expect(
      postTradeAnalysesRepository.createPostTradeAnalysis({
        tradeId: "00000000-0000-0000-0000-000000000000",
        tradeSource: "JOURNAL_TRADE",
        outcome: "LOSS",
      }),
    ).rejects.toThrow(NotFoundError);

    await expect(
      postTradeAnalysesRepository.createPostTradeAnalysis({
        tradeId: "00000000-0000-0000-0000-000000000000",
        tradeSource: "BACKTEST_TRADE",
        outcome: "LOSS",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("emits STRATEGY_VERSION_PROPOSED when a new StrategyVersion is created", async () => {
    const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
    expect(strategy).not.toBeNull();
    if (!strategy) return;

    const versionLabel = `integration-test-${Date.now()}`;
    const version = await strategiesRepository.createStrategyVersion({
      strategyId: strategy.id,
      version: versionLabel,
      name: "Integration test version",
      description: "Created only to verify STRATEGY_VERSION_PROPOSED emission.",
      parameters: { integrationTest: true },
      status: "DISCOVERED",
    });

    const events = await journalEventsRepository.listJournalEvents({ correlationId: version.id });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("STRATEGY_VERSION_PROPOSED");
    expect(events[0]?.entityType).toBe("STRATEGY_VERSION");
    expect(events[0]?.entityId).toBe(version.id);
    expect(events[0]?.strategyId).toBe(strategy.id);
  });
});
