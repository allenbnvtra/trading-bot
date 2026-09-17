import Decimal from "decimal.js";
import { z } from "zod";
import type { Candle } from "@trading-copilot/trading-domain";
import type { Direction } from "@trading-copilot/shared-types";
import { calculateEma } from "../indicators/ema";
import { calculateAtr } from "../indicators/atr";

/**
 * "EMA Trend Pullback v1.0.0" — the Milestone 1 example strategy.
 *
 * This is deliberately NOT tuned for profitability (see CLAUDE.md). Its only
 * purpose is to exercise the strategy/backtester infrastructure end to end.
 *
 * Parameters are validated with `emaTrendPullbackParametersSchema` before any
 * evaluation. Unknown keys and invalid values (e.g. a zero/negative period)
 * are rejected outright rather than silently defaulted, so a caller can
 * never accidentally run a strategy with parameters it didn't explicitly
 * intend. The v1.0.0 default parameter values are documented here, but they
 * are not baked into the schema as `.default()` — every StrategyVersion
 * persists its parameters explicitly.
 */
export const emaTrendPullbackParametersSchema = z
  .object({
    fastEmaPeriod: z.number().int().positive(),
    slowEmaPeriod: z.number().int().positive(),
    atrPeriod: z.number().int().positive(),
    stopAtrMultiplier: z.number().positive(),
    targetAtrMultiplier: z.number().positive(),
    allowLong: z.boolean(),
    allowShort: z.boolean(),
  })
  .strict();

export type EmaTrendPullbackParameters = z.infer<typeof emaTrendPullbackParametersSchema>;

/** v1.0.0 default parameters, per the strategy spec. Not applied silently. */
export const EMA_TREND_PULLBACK_V1_DEFAULT_PARAMETERS: EmaTrendPullbackParameters = {
  fastEmaPeriod: 20,
  slowEmaPeriod: 50,
  atrPeriod: 14,
  stopAtrMultiplier: 1,
  targetAtrMultiplier: 2,
  allowLong: true,
  allowShort: true,
};

export interface StrategySignal {
  index: number;
  timestamp: Date;
  direction: Direction;
  closeAtSignal: Decimal;
  atrAtSignal: Decimal;
  entryReason: string;
}

/**
 * Look-ahead-safe by construction: deciding about index `i` only ever reads
 * `candles[0..i]` (the EMA/ATR arrays are computed once over the whole
 * series, but each index `i` of those arrays is itself only a function of
 * `values[0..i]` — see calculateEma/calculateAtr). This function does NOT
 * decide entry price or timing; that is the backtester's job. A signal
 * detected using candle i's close may only be acted on starting candle i+1
 * (see docs/backtesting-assumptions.md).
 */
export function evaluateEmaTrendPullback(
  candles: Candle[],
  parameters: EmaTrendPullbackParameters,
): StrategySignal[] {
  const params = emaTrendPullbackParametersSchema.parse(parameters);

  const closes = candles.map((candle) => candle.close);
  const fastEma = calculateEma(closes, params.fastEmaPeriod);
  const slowEma = calculateEma(closes, params.slowEmaPeriod);
  const atr = calculateAtr(candles, params.atrPeriod);

  const signals: StrategySignal[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const fastNow = fastEma[i];
    const fastPrev = fastEma[i - 1];
    const slowNow = slowEma[i];
    const atrNow = atr[i];

    // Still warming up: at least one indicator has no value yet at i or i-1.
    if (fastNow == null || fastPrev == null || slowNow == null || atrNow == null) {
      continue;
    }

    const closeNow = closes[i] as Decimal;
    const closePrev = closes[i - 1] as Decimal;
    const candle = candles[i] as Candle;

    const isLongSignal =
      fastNow.greaterThan(slowNow) &&
      closePrev.lessThanOrEqualTo(fastPrev) &&
      closeNow.greaterThan(fastNow);

    if (params.allowLong && isLongSignal) {
      signals.push({
        index: i,
        timestamp: candle.timestamp,
        direction: "LONG",
        closeAtSignal: closeNow,
        atrAtSignal: atrNow,
        entryReason: `EMA(${params.fastEmaPeriod}) crossed above EMA(${params.slowEmaPeriod}) trend with pullback confirmation`,
      });
      continue;
    }

    const isShortSignal =
      fastNow.lessThan(slowNow) &&
      closePrev.greaterThanOrEqualTo(fastPrev) &&
      closeNow.lessThan(fastNow);

    if (params.allowShort && isShortSignal) {
      signals.push({
        index: i,
        timestamp: candle.timestamp,
        direction: "SHORT",
        closeAtSignal: closeNow,
        atrAtSignal: atrNow,
        entryReason: `EMA(${params.fastEmaPeriod}) crossed below EMA(${params.slowEmaPeriod}) trend with pullback confirmation`,
      });
    }
  }

  return signals;
}

/**
 * Registry of strategy implementations keyed by `Strategy.key`, so callers
 * (the backtester, the API) can look up an evaluator + parameter schema
 * without hardcoding a switch statement on strategy key.
 */
export const STRATEGY_REGISTRY = {
  "ema-trend-pullback": {
    parametersSchema: emaTrendPullbackParametersSchema,
    evaluate: evaluateEmaTrendPullback,
  },
} as const;

export type StrategyKey = keyof typeof STRATEGY_REGISTRY;
