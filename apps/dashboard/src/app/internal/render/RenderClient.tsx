"use client";

import { useEffect } from "react";
import ChartRenderer, { type ChartRendererProps } from "@/components/ChartRenderer";
import { setRenderError, setRenderReady } from "@/lib/render-ready";

// This file must NEVER import @trading-copilot/shared-types. It is a
// "use client" component, so its imports get bundled into the browser JS -
// shared-types' barrel transitively pulls in node:crypto (via
// tradingview.ts), which is unsafe in a client bundle (see Task 6's
// ChartRenderer, which hit and fixed exactly this). Any shared-types
// constant either render route needs (chartConfigVersion, candle-count
// default) is read once, server-side, in the relevant page.tsx (a Server
// Component, where that import is safe), and passed down here as a plain
// prop.
//
// Shared between both internal render routes (`render/setup/[setupId]` -
// PRE_TRADE - and `render/trade/[tradeId]` - POST_TRADE) rather than
// duplicated, since the two only differ in which data the server component
// fetches and what it passes down; the actual client-side
// render/render-ready wiring is identical.

export interface RenderClientCandle {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface RenderClientAnnotations {
  entry: string | null;
  stop: string | null;
  target1: string | null;
  target2: string | null;
  vwap: string | null;
  support: string | null;
  resistance: string | null;
}

interface RenderClientErrorProps {
  errorCode: string;
  errorMessage: string;
}

interface RenderClientDataProps {
  errorCode?: undefined;
  /**
   * Which screenshot type this render is for. Not otherwise consumed here
   * (ChartRenderer draws whatever candles/annotations/infoPanel it's given,
   * regardless of type) - accepted purely so the two page.tsx callers share
   * one discriminated prop shape instead of two near-identical components.
   * Task 9's Playwright worker reads the type off the TradeScreenshot row it
   * already holds, never off this DOM.
   */
  screenshotType: "PRE_TRADE" | "POST_TRADE";
  instrument: { symbol: string; tickSize: string } | null;
  timeframe: string;
  strategyLabel: string;
  direction: "LONG" | "SHORT";
  status: string;
  decisionTimestamp: string;
  candles: RenderClientCandle[];
  annotations: RenderClientAnnotations;
  infoPanel: Record<string, string | number | null>;
  /**
   * Accepted for parity with what each page always passes (and as the
   * value's one server-side source of truth), but not otherwise consumed
   * here: Task 9's Playwright worker reads chartConfigVersion off the
   * TradeScreenshot row it already holds, never off this DOM, so there is
   * nothing further for this component to do with it today.
   */
  chartConfigVersion: string;
}

export type RenderClientProps = RenderClientErrorProps | RenderClientDataProps;

/**
 * Thin client-side wrapper around ChartRenderer. Exists only so the sibling
 * page.tsx files can stay `async` Server Components (so they can `await`
 * the API calls) - the render-ready DOM signal (`lib/render-ready.ts`) needs
 * `document`, which only exists client-side.
 *
 * Two render paths, both of which must still leave
 * `document.body.dataset.renderState` set to "ready" or "error" exactly
 * once, per the render-ready contract Playwright (Task 9) polls for:
 *  - A server-side failure (missing Setup/JournalTrade/MarketSnapshot/
 *    candles, or a JournalTrade that isn't CLOSED yet) never reaches
 *    ChartRenderer at all - this component signals the error itself,
 *    directly, from the `errorCode`/`errorMessage` props.
 *  - Otherwise, ChartRenderer is mounted and drives the signal itself via
 *    its own onReady/onError callbacks (wired straight to
 *    setRenderReady/setRenderError).
 */
export default function RenderClient(props: RenderClientProps) {
  const isError = typeof props.errorCode === "string";
  const errorCode = isError ? (props as RenderClientErrorProps).errorCode : null;
  const errorMessage = isError ? (props as RenderClientErrorProps).errorMessage : null;

  useEffect(() => {
    if (errorCode !== null && errorMessage !== null) {
      setRenderError(errorCode, errorMessage);
    }
    // Nothing else to signal here on the success path - ChartRenderer's own
    // onReady/onError callbacks below handle that.
  }, [errorCode, errorMessage]);

  if (isError) {
    // Inert markup, hidden - the actual signal was already sent above via
    // the DOM dataset contract, which is what Playwright polls for.
    return (
      <div data-render-client-state="error" style={{ display: "none" }}>
        {errorCode}: {errorMessage}
      </div>
    );
  }

  const data = props as RenderClientDataProps;

  return (
    <ChartRenderer
      // `instrument` may be null here (the best-effort getInstrument() call
      // in page.tsx failed or the trade/setup's instrument couldn't be
      // found). ChartRenderer's own prop type requires a non-null value,
      // but its render-phase try/catch (Task 6) is explicitly built to
      // catch and report exactly this kind of runtime-only API-boundary
      // mismatch as onError("RENDER_EXCEPTION", ...) rather than crash -
      // see ChartRenderer.test.tsx's "malformed prop" case, which asserts
      // this.
      instrument={data.instrument as ChartRendererProps["instrument"]}
      timeframe={data.timeframe}
      strategyLabel={data.strategyLabel}
      direction={data.direction}
      status={data.status}
      decisionTimestamp={data.decisionTimestamp}
      candles={data.candles}
      annotations={data.annotations}
      infoPanel={data.infoPanel}
      onReady={setRenderReady}
      onError={setRenderError}
    />
  );
}
