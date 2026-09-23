import Decimal from "decimal.js";
import type { Direction } from "@trading-copilot/shared-types";

/**
 * Shared by every strategy implementation registered in STRATEGY_REGISTRY,
 * moved out of ema-trend-pullback.ts once a second strategy
 * (strategy-definition.ts) needed the same shape.
 */
export interface StrategySignal {
  index: number;
  timestamp: Date;
  direction: Direction;
  closeAtSignal: Decimal;
  atrAtSignal: Decimal;
  entryReason: string;
}
