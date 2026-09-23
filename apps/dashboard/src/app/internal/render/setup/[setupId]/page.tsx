import {
  getCandlesUpToTimestamp,
  getInstrument,
  getLatestRiskCalculation,
  getMarketSnapshot,
  getSetup,
  getStrategy,
} from "@/lib/api";
// This file is an `async` Server Component (no "use client" directive), so
// it executes only on the Node.js server - Next.js's App Router never ships
// a Server Component's imports to the browser bundle. Importing these two
// constants directly from @trading-copilot/shared-types here is therefore
// safe and does NOT repeat Task 6's problem (ChartRenderer had to drop this
// same dependency because it's a "use client" component whose imports do
// get bundled, and shared-types' barrel transitively pulls in node:crypto).
// The shared RenderClient.tsx (../../RenderClient, also used by the
// POST_TRADE trade render route) IS a client component and must never
// import from shared-types - any constant it needs is passed down from here
// as a plain prop instead.
import { CHART_CONFIG_VERSION, PRE_TRADE_CANDLE_COUNT_DEFAULT } from "@trading-copilot/shared-types";
import RenderClient from "../../RenderClient";

/**
 * Internal, Playwright-only route (Task 9, not yet built) that renders a
 * single PRE_TRADE chart for one Setup. Never linked from normal dashboard
 * navigation.
 *
 * This route calls, server-side, only: GET /setups/:id, GET
 * /market-snapshots/:id, GET /setups/:id/risk-calculations/latest
 * (best-effort, 404 tolerated), GET /instruments/:id, GET /strategies/:id
 * (best-effort, for a human-readable strategy name only), and the
 * cutoff-safe GET /market-data/candles endpoint. It must never call any
 * journal/trades endpoint - that is the structural anti-look-ahead
 * guarantee for this route (a PRE_TRADE screenshot must be provably unable
 * to see how the trade actually turned out). GET /strategies/:id is a
 * strategy-definition lookup, not a journal/trades/outcome endpoint, so
 * calling it does not weaken that guarantee.
 */
export default async function RenderSetupPage({
  params,
}: {
  params: Promise<{ setupId: string }>;
}) {
  const { setupId } = await params;

  const setup = await getSetup(setupId).catch(() => null);
  if (!setup) {
    return <RenderClient errorCode="SETUP_NOT_FOUND" errorMessage={`Setup ${setupId} not found`} />;
  }

  const snapshot = await getMarketSnapshot(setup.marketSnapshotId).catch(() => null);
  if (!snapshot) {
    return (
      <RenderClient
        errorCode="MARKET_SNAPSHOT_NOT_FOUND"
        errorMessage="Setup's MarketSnapshot is missing"
      />
    );
  }

  const instrument = await getInstrument(setup.instrumentId).catch(() => null);

  // Best-effort - a Setup may not have a RiskCalculation yet (plannedStop/
  // plannedTarget1 can still be null at WATCH). Missing is rendered as
  // "unknown" (a null infoPanel value, which ChartRenderer omits entirely),
  // never fabricated.
  const riskCalculation = await getLatestRiskCalculation(setupId).catch(() => null);

  // The one line in this whole route that matters most: the cutoff is
  // MarketSnapshot.timestamp - the Setup's actual decision time, fetched
  // server-side from the real MarketSnapshot row above - never `new Date()`
  // and never a client/URL-controlled value. See
  // docs/screenshot-design.md "Authoritative cutoff".
  const candles = await getCandlesUpToTimestamp(
    setup.instrumentId,
    snapshot.timeframe,
    snapshot.timestamp,
    PRE_TRADE_CANDLE_COUNT_DEFAULT,
  ).catch(() => []);

  if (candles.length === 0) {
    return (
      <RenderClient
        errorCode="NO_CANDLES"
        errorMessage="No candles available at or before the cutoff"
      />
    );
  }

  // Best-effort strategy-name lookup, same pattern as the RiskCalculation
  // fetch above (`.catch(() => null)`). GET /strategies/:id is a
  // strategy-definition endpoint, not a journal/trades/outcome endpoint, so
  // calling it here doesn't touch the anti-look-ahead guarantee this route
  // is built around. Falls back to the raw strategyId - never a fabricated
  // name - if the lookup fails for any reason.
  const strategy = await getStrategy(setup.strategyId).catch(() => null);
  const strategyLabel = strategy?.name ?? setup.strategyId;

  return (
    <RenderClient
      screenshotType="PRE_TRADE"
      instrument={instrument ? { symbol: instrument.symbol, tickSize: instrument.tickSize } : null}
      timeframe={snapshot.timeframe}
      strategyLabel={strategyLabel}
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
