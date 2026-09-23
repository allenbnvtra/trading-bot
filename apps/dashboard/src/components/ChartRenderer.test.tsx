import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChartRenderer, { type ChartRendererProps } from "./ChartRenderer";

function baseProps(overrides: Partial<ChartRendererProps> = {}): ChartRendererProps {
  return {
    instrument: { symbol: "ES", tickSize: "0.25" },
    timeframe: "5m",
    strategyLabel: "Opening Range Breakout v1",
    direction: "LONG",
    status: "PLANNED",
    decisionTimestamp: "2026-01-01T00:00:00.000Z",
    candles: [],
    annotations: {
      entry: null,
      stop: null,
      target1: null,
      target2: null,
      vwap: null,
      support: null,
      resistance: null,
    },
    infoPanel: {},
    onReady: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("ChartRenderer render-phase safety", () => {
  it("calls onError instead of throwing when a prop is malformed at runtime", () => {
    // Realistic runtime-only failure: `instrument` is ultimately sourced from
    // a database Record<string, unknown>-ish field via an API boundary, so a
    // null/undefined value here (despite the static prop type) is a real
    // possibility, not paranoia. Accessing `.symbol`/`.tickSize` on it must
    // not throw past this component - both callers of onReady/onError below
    // are the render-ready contract Playwright polls for, so an uncaught
    // throw here would hang that wait forever.
    const onError = vi.fn();
    const onReady = vi.fn();
    const props = baseProps({
      instrument: null as unknown as ChartRendererProps["instrument"],
      onError,
      onReady,
    });

    expect(() => render(<ChartRenderer {...props} />)).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("RENDER_EXCEPTION", expect.any(String));
    expect(onReady).not.toHaveBeenCalled();
  });

  // Note: deliberately no "well-formed props" companion test here that
  // exercises the real chart-drawing effect. lightweight-charts' canvas
  // rendering depends on browser APIs (matchMedia, real canvas 2D contexts)
  // that jsdom (this project's vitest environment) does not implement, so
  // mounting it with valid props throws unrelated environment errors from
  // inside the charting library itself - not a signal about this
  // component's own render-phase safety, which is what this file covers.
  // The malformed-props case above short-circuits before createChart() is
  // ever called, so it isn't affected by that gap.
});
