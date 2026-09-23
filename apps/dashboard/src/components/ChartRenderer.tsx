"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, LineStyle, createChart } from "lightweight-charts";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";

// Mirrors packages/shared-types/src/screenshot.ts's SCREENSHOT_RENDER_WIDTH/HEIGHT -
// the dashboard never takes a workspace dependency on @trading-copilot/shared-types
// (apps/dashboard/src/lib/api.ts documents why: it stays decoupled from backend
// package internals, and that package's CJS barrel also transitively pulls in
// node:crypto via tradingview.ts, which is unsafe in a client bundle).
const SCREENSHOT_RENDER_WIDTH = 1440;
const SCREENSHOT_RENDER_HEIGHT = 900;

export interface ChartRendererCandle {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface ChartRendererAnnotations {
  entry: string | null;
  stop: string | null;
  target1: string | null;
  target2: string | null;
  vwap: string | null;
  support: string | null;
  resistance: string | null;
}

export interface ChartRendererProps {
  instrument: { symbol: string; tickSize: string };
  timeframe: string;
  strategyLabel: string;
  direction: "LONG" | "SHORT";
  status: string;
  decisionTimestamp: string;
  candles: ChartRendererCandle[];
  annotations: ChartRendererAnnotations;
  infoPanel: Record<string, string | number | null>;
  onReady: () => void;
  onError: (code: string, message: string) => void;
}

interface AnnotationLineSpec {
  key: keyof ChartRendererAnnotations;
  label: string;
  color: string;
  lineStyle: LineStyle;
}

/**
 * Exactly the seven annotation lines this chart is allowed to draw - see the
 * Task 6 brief ("keep it to these seven lines, never more, per 'do not
 * clutter the chart'"). Do not add an eighth without updating that contract.
 */
const ANNOTATION_LINE_SPECS: readonly AnnotationLineSpec[] = [
  { key: "entry", label: "Entry", color: "#2563eb", lineStyle: LineStyle.Solid },
  { key: "stop", label: "Stop", color: "#dc2626", lineStyle: LineStyle.Solid },
  { key: "target1", label: "Target 1", color: "#16a34a", lineStyle: LineStyle.Solid },
  { key: "target2", label: "Target 2", color: "#16a34a", lineStyle: LineStyle.Solid },
  { key: "vwap", label: "VWAP", color: "#9333ea", lineStyle: LineStyle.Dashed },
  { key: "support", label: "Support", color: "#6b7280", lineStyle: LineStyle.Dashed },
  { key: "resistance", label: "Resistance", color: "#6b7280", lineStyle: LineStyle.Dashed },
] as const;

/**
 * Converts an infoPanel key like "rMultiple" into a display label like
 * "R Multiple". Purely cosmetic - it never touches the value.
 */
function labelFor(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Lightweight Charts needs a UNIX-seconds timestamp for its own internal
 * rendering. This is a display-only conversion of an already-known
 * timestamp, never a value fed back into any calculation.
 */
function toUtcTimestamp(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

/**
 * Renders a fixed-size, non-interactive candlestick chart plus an info
 * panel, for Playwright screenshot capture (Task 9, not yet built). This
 * component never computes a financial value: it only parses
 * already-computed decimal strings into numbers for the charting library's
 * own internal rendering, and displays whatever `infoPanel` values it is
 * given verbatim.
 *
 * It signals completion through the render-ready DOM contract
 * (`lib/render-ready.ts`) via `onReady`/`onError`. Playwright polls
 * `document.body.dataset.renderState` for one of those two outcomes with a
 * bounded timeout, so both callbacks must fire exactly once per render and
 * must cover every code path that could otherwise throw silently and hang
 * that wait forever.
 */
export default function ChartRenderer(props: ChartRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { candles, annotations, onReady, onError } = props;

  // Everything that reads a prop and could throw during React's synchronous
  // render pass - not just the chart-drawing effect below - is computed here,
  // inside a try/catch, before any JSX that would reference those props is
  // built. This is deliberately not a defensive-typing exercise: this
  // component ultimately renders data sourced from a database
  // Record<string, unknown>-ish field via an API boundary, so a runtime shape
  // mismatch that TypeScript's static types can't catch (e.g. a malformed
  // `instrument`) is a real possibility. If this throws, `onError` fires and
  // we render fallback markup instead of the chart, so
  // `document.body.dataset.renderState` is always set one way or the other
  // and Playwright never hangs waiting for a signal that was never sent.
  let renderError: unknown = null;
  let headerLine1 = "";
  let headerLine2 = "";
  let infoRows: [string, string | number][] = [];

  try {
    headerLine1 = `${props.instrument.symbol} - ${props.timeframe} - ${props.strategyLabel}`;
    headerLine2 = `${props.direction} - ${props.status} - ${props.decisionTimestamp} - tick ${props.instrument.tickSize}`;
    // A `null` infoPanel value means "not applicable to this setup/trade" and
    // is omitted from the panel entirely, per the Task 6 brief. This is its
    // own convention, not a match for anything else in the dashboard - e.g.
    // `apps/dashboard/src/app/setups/[id]/page.tsx`'s `plannedPriceValue`
    // renders a "Not set" placeholder for a null price rather than omitting
    // the row, which is a different (also valid) choice for a different
    // context.
    infoRows = Object.entries(props.infoPanel).filter(
      (entry): entry is [string, string | number] => entry[1] !== null,
    );
  } catch (err) {
    renderError = err;
  }

  useEffect(() => {
    let chart: IChartApi | null = null;
    let rafId: number | null = null;
    let cancelled = false;

    if (renderError !== null) {
      // Already reported at render time (below); nothing to draw.
      try {
        onError("RENDER_EXCEPTION", String(renderError));
      } catch {
        // Best-effort; there is nothing further we can do if onError itself throws.
      }
      return () => {
        cancelled = true;
      };
    }

    try {
      const container = containerRef.current;
      if (!container) {
        throw new Error("ChartRenderer: chart container did not mount");
      }

      chart = createChart(container, {
        width: SCREENSHOT_RENDER_WIDTH,
        height: SCREENSHOT_RENDER_HEIGHT,
        autoSize: false,
        layout: {
          background: { color: "#ffffff" },
          textColor: "#1f2937",
        },
        grid: {
          vertLines: { color: "#e5e7eb" },
          horzLines: { color: "#e5e7eb" },
        },
        timeScale: {
          borderColor: "#d1d5db",
        },
        rightPriceScale: {
          borderColor: "#d1d5db",
        },
      });

      const series: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
        upColor: "#16a34a",
        downColor: "#dc2626",
        borderVisible: false,
        wickUpColor: "#16a34a",
        wickDownColor: "#dc2626",
      });

      series.setData(
        candles.map((candle) => ({
          time: toUtcTimestamp(candle.timestamp),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
        })),
      );

      for (const spec of ANNOTATION_LINE_SPECS) {
        const value = annotations[spec.key];
        if (value === null) continue;
        series.createPriceLine({
          price: Number(value),
          color: spec.color,
          lineWidth: 2,
          lineStyle: spec.lineStyle,
          axisLabelVisible: true,
          title: spec.label,
        });
      }

      chart.timeScale().fitContent();

      // A single requestAnimationFrame after fitContent(), so the canvas has
      // actually painted before we tell Playwright it's safe to screenshot -
      // never call onReady synchronously here, or it may capture a blank
      // canvas.
      rafId = window.requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          onReady();
        } catch (err) {
          onError("RENDER_EXCEPTION", String(err));
        }
      });
    } catch (err) {
      onError("RENDER_EXCEPTION", String(err));
    }

    return () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      try {
        chart?.remove();
      } catch {
        // Best-effort cleanup after unmount; nothing left to signal.
      }
    };
  }, [renderError, candles, annotations, onReady, onError]);

  if (renderError !== null) {
    // The error was already reported to onError above (in the effect); this
    // is deliberately not the chart - just inert fallback markup so React
    // never has to throw past this point for the same bad props.
    return <div data-chart-renderer-state="error" style={{ display: "none" }} />;
  }

  return (
    <div
      style={{
        width: SCREENSHOT_RENDER_WIDTH,
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#1f2937",
        background: "#ffffff",
      }}
    >
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{headerLine1}</div>
        <div style={{ fontSize: 13, color: "#4b5563" }}>{headerLine2}</div>
      </div>
      <div
        ref={containerRef}
        style={{ width: SCREENSHOT_RENDER_WIDTH, height: SCREENSHOT_RENDER_HEIGHT }}
      />
      {infoRows.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "4px 24px",
            padding: "12px 16px",
            borderTop: "1px solid #e5e7eb",
            fontSize: 13,
          }}
        >
          {infoRows.map(([key, value]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: "#6b7280" }}>{labelFor(key)}</span>
              <span style={{ fontWeight: 500 }}>{String(value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
