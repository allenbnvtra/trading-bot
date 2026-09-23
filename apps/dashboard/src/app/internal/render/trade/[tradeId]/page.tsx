import {
  getCandlesUpToTimestamp,
  getInstrument,
  getJournalTrade,
  getMarketSnapshot,
  getSetup,
  getStrategy,
} from "@/lib/api";
import { signOf } from "@/lib/format";
// This file is an `async` Server Component (no "use client" directive), so
// it executes only on the Node.js server - see
// `../../setup/[setupId]/page.tsx` for the full explanation of why this
// import is safe here but forbidden in the shared RenderClient.tsx.
import { CHART_CONFIG_VERSION, PRE_TRADE_CANDLE_COUNT_DEFAULT } from "@trading-copilot/shared-types";
import RenderClient from "../../RenderClient";

/**
 * Internal, Playwright-only route (Task 9) that renders a single POST_TRADE
 * chart for one JournalTrade. Never linked from normal dashboard
 * navigation.
 *
 * This route calls, server-side, only: GET /journal/trades/:id, GET
 * /setups/:id (best-effort, only when the trade has a setupId - purely for
 * the MarketSnapshot it points at), GET /market-snapshots/:id (via that
 * Setup - timeframe/VWAP/support/resistance context, same as PRE_TRADE),
 * GET /instruments/:id, GET /strategies/:id (best-effort, for a
 * human-readable strategy name only), and the cutoff-safe GET
 * /market-data/candles endpoint. Unlike the PRE_TRADE route, this one is
 * explicitly ABOUT the trade's actual outcome (that is the whole point of a
 * POST_TRADE screenshot) - the anti-look-ahead property this route upholds
 * instead is that the candle cutoff never extends past the moment the
 * outcome was actually known (`exitTimestamp`), never `new Date()` at
 * render time.
 */
export default async function RenderTradePage({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}) {
  const { tradeId } = await params;

  const trade = await getJournalTrade(tradeId).catch(() => null);
  if (!trade) {
    return <RenderClient errorCode="TRADE_NOT_FOUND" errorMessage={`JournalTrade ${tradeId} not found`} />;
  }

  // Airtight guard, checked before any other POST_TRADE-specific fetch or
  // render: a POST_TRADE screenshot of a trade that hasn't closed yet would
  // show incomplete/misleading data (no actualExit, no final mfe/mae/
  // rMultiple/netPnl). `exitTimestamp` is also asserted non-null here even
  // though the closeJournalTrade repository call guarantees CLOSED implies
  // exitTimestamp is set - defensive, never trust the static type alone for
  // a value that becomes this route's cutoff.
  if (trade.status !== "CLOSED" || !trade.exitTimestamp) {
    return (
      <RenderClient
        errorCode="TRADE_NOT_CLOSED"
        errorMessage="POST_TRADE screenshots require a closed trade"
      />
    );
  }

  // A JournalTrade's setupId is genuinely optional (a manually-journaled
  // PAPER/MANUAL_LIVE trade need not have gone through the Setup pipeline).
  // Best-effort: a Setup fetch failing (or setupId being unset) collapses
  // into the same MARKET_SNAPSHOT_NOT_FOUND error as Task 7's route, since
  // from this chart's perspective a missing Setup and a missing
  // MarketSnapshot have the same consequence - no timeframe, no VWAP/
  // support/resistance context, nothing to safely render.
  const setup = trade.setupId ? await getSetup(trade.setupId).catch(() => null) : null;
  const snapshot = setup ? await getMarketSnapshot(setup.marketSnapshotId).catch(() => null) : null;
  if (!snapshot) {
    return (
      <RenderClient
        errorCode="MARKET_SNAPSHOT_NOT_FOUND"
        errorMessage="No MarketSnapshot available for this trade (no linked Setup, or its MarketSnapshot could not be loaded)"
      />
    );
  }

  const instrument = await getInstrument(trade.instrumentId).catch(() => null);

  // The one line in this whole route that matters most: the cutoff is
  // trade.exitTimestamp - the trade's actual close time, fetched
  // server-side from the real JournalTrade row above - never `new Date()`
  // and never a client/URL-controlled value. See
  // docs/screenshot-design.md "Authoritative cutoff" (Task 7's analogous
  // comment for the PRE_TRADE route uses MarketSnapshot.timestamp instead).
  const candles = await getCandlesUpToTimestamp(
    trade.instrumentId,
    snapshot.timeframe,
    trade.exitTimestamp,
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

  // Best-effort strategy-name lookup, same pattern as Task 7's route. GET
  // /strategies/:id is a strategy-definition endpoint, not a
  // journal/trades/outcome endpoint.
  const strategy = await getStrategy(trade.strategyId).catch(() => null);
  const strategyLabel = strategy?.name ?? trade.strategyId;

  // WIN/LOSS/BREAKEVEN, derived the same way the rest of this dashboard
  // classifies an already-computed netPnl (see e.g.
  // `apps/dashboard/src/components/TradesTable.tsx`'s use of `signOf` for
  // P&L coloring) - never a new financial calculation, just a label on top
  // of the backend-computed netPnl sign.
  const outcome =
    signOf(trade.netPnl) === "positive" ? "WIN" : signOf(trade.netPnl) === "negative" ? "LOSS" : "BREAKEVEN";

  return (
    <RenderClient
      screenshotType="POST_TRADE"
      instrument={instrument ? { symbol: instrument.symbol, tickSize: instrument.tickSize } : null}
      timeframe={snapshot.timeframe}
      strategyLabel={strategyLabel}
      direction={trade.direction}
      status={trade.status}
      decisionTimestamp={trade.exitTimestamp}
      candles={candles}
      annotations={{
        entry: trade.plannedEntry,
        stop: trade.plannedStop,
        target1: trade.plannedTarget1,
        target2: trade.plannedTarget2,
        vwap: snapshot.vwap,
        support: snapshot.nearestSupport,
        resistance: snapshot.nearestResistance,
      }}
      infoPanel={{
        risk: trade.plannedRisk,
        quantity: trade.quantity,
        actualEntry: trade.actualEntry,
        actualExit: trade.actualExit,
        mfe: trade.mfe,
        mae: trade.mae,
        rMultiple: trade.rMultiple,
        netPnl: trade.netPnl,
        outcome,
      }}
      chartConfigVersion={CHART_CONFIG_VERSION}
    />
  );
}
