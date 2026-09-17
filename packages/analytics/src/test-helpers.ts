import Decimal from "decimal.js";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";

/** Test-only fixture builders shared across packages/analytics unit tests. */

export const D = (value: string | number) => new Decimal(value);
export const DN = (value: string | number | null) => (value === null ? null : new Decimal(value));

let sequence = 0;

/**
 * Builds a NormalizedTrade with sensible defaults so each test only sets the
 * fields it cares about. `netPnl` defaults to `grossPnl - fees` when not
 * given explicitly, matching the real relationship between these fields (but
 * tests are free to override `netPnl` directly to hand-construct win/loss
 * scenarios without worrying about grossPnl/fees arithmetic).
 */
export function makeTrade(overrides: Partial<NormalizedTrade> = {}): NormalizedTrade {
  sequence += 1;
  const grossPnl = overrides.grossPnl ?? D(0);
  const fees = overrides.fees ?? D(0);
  return {
    source: "BACKTEST",
    id: `trade-${sequence}`,
    strategyId: "strategy-1",
    strategyVersionId: "strategy-version-1",
    instrumentId: "instrument-1",
    direction: "LONG",
    executionMode: "BACKTEST",
    entryTimestamp: new Date(Date.UTC(2024, 0, sequence)),
    exitTimestamp: new Date(Date.UTC(2024, 0, sequence, 1)),
    entryPrice: D(100),
    exitPrice: D(100),
    quantity: 1,
    grossPnl,
    fees,
    netPnl: overrides.netPnl ?? grossPnl.minus(fees),
    riskAmount: null,
    rMultiple: null,
    mfe: null,
    mae: null,
    slippage: null,
    ...overrides,
  };
}

/** Shorthand for a trade whose only relevant field for a test is netPnl. */
export function tradeWithPnl(netPnl: number | string, overrides: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return makeTrade({ netPnl: D(netPnl), ...overrides });
}
