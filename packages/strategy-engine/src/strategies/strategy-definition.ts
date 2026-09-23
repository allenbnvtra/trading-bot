import Decimal from "decimal.js";
import { z } from "zod";
import type { Candle } from "@trading-copilot/trading-domain";
import { calculateAtr } from "../indicators/atr";
import { calculateEma } from "../indicators/ema";
import type { StrategySignal } from "../types";

/**
 * The safe, schema-validated rule grammar an AI-proposed StrategyDefinition
 * must use: no arbitrary code, no dynamic TypeScript generation (that
 * would reintroduce the exact code-injection risk this DSL exists to
 * prevent). Generalizes ema-trend-pullback.ts's fast/slow-EMA-cross shape
 * into a declarative rule a human or the ResearchAgent can compose from a
 * small closed set of conditions. Every rule references only indicators
 * this package already computes deterministically.
 */
const emaCrossAboveRuleSchema = z
  .object({
    type: z.literal("EMA_CROSS_ABOVE"),
    fastPeriod: z.number().int().positive(),
    slowPeriod: z.number().int().positive(),
  })
  .strict();

const emaCrossBelowRuleSchema = z
  .object({
    type: z.literal("EMA_CROSS_BELOW"),
    fastPeriod: z.number().int().positive(),
    slowPeriod: z.number().int().positive(),
  })
  .strict();

const closeAboveEmaRuleSchema = z
  .object({
    type: z.literal("CLOSE_ABOVE_EMA"),
    period: z.number().int().positive(),
  })
  .strict();

const closeBelowEmaRuleSchema = z
  .object({
    type: z.literal("CLOSE_BELOW_EMA"),
    period: z.number().int().positive(),
  })
  .strict();

const entryRuleSchema = z.discriminatedUnion("type", [
  emaCrossAboveRuleSchema,
  emaCrossBelowRuleSchema,
  closeAboveEmaRuleSchema,
  closeBelowEmaRuleSchema,
]);

export type EntryRule = z.infer<typeof entryRuleSchema>;

/**
 * "parameters" for the "ai-generated-dsl-v1" STRATEGY_REGISTRY key IS this
 * whole document (not a separate parameters object): the DSL document is
 * itself what a StrategyVersion.parameters column stores for that key. All
 * entryRules must agree (ANDed together) for a signal to fire on a given
 * candle; direction fixes which side the strategy trades (a hypothesis
 * that wants both sides proposes two separate StrategyDefinitions).
 */
export const strategyDefinitionSchema = z
  .object({
    version: z.literal("1.0.0"),
    direction: z.enum(["LONG", "SHORT"]),
    entryRules: z.array(entryRuleSchema).min(1),
    atrPeriod: z.number().int().positive(),
    stopAtrMultiplier: z.number().positive(),
    targetAtrMultiplier: z.number().positive(),
  })
  .strict();

export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;

interface RuleEvaluationContext {
  index: number;
  closes: Decimal[];
  emaCache: Map<number, Array<Decimal | null>>;
}

function getEma(ctx: RuleEvaluationContext, period: number): Array<Decimal | null> {
  let cached = ctx.emaCache.get(period);
  if (!cached) {
    cached = calculateEma(ctx.closes, period);
    ctx.emaCache.set(period, cached);
  }
  return cached;
}

function evaluateRule(rule: EntryRule, ctx: RuleEvaluationContext): boolean {
  const { index } = ctx;
  if (index < 1) {
    return false;
  }

  switch (rule.type) {
    case "EMA_CROSS_ABOVE": {
      const fast = getEma(ctx, rule.fastPeriod);
      const slow = getEma(ctx, rule.slowPeriod);
      const fastNow = fast[index];
      const fastPrev = fast[index - 1];
      const slowNow = slow[index];
      const slowPrev = slow[index - 1];
      if (fastNow == null || fastPrev == null || slowNow == null || slowPrev == null) {
        return false;
      }
      return fastPrev.lessThanOrEqualTo(slowPrev) && fastNow.greaterThan(slowNow);
    }
    case "EMA_CROSS_BELOW": {
      const fast = getEma(ctx, rule.fastPeriod);
      const slow = getEma(ctx, rule.slowPeriod);
      const fastNow = fast[index];
      const fastPrev = fast[index - 1];
      const slowNow = slow[index];
      const slowPrev = slow[index - 1];
      if (fastNow == null || fastPrev == null || slowNow == null || slowPrev == null) {
        return false;
      }
      return fastPrev.greaterThanOrEqualTo(slowPrev) && fastNow.lessThan(slowNow);
    }
    case "CLOSE_ABOVE_EMA": {
      const ema = getEma(ctx, rule.period);
      const emaNow = ema[index];
      if (emaNow == null) {
        return false;
      }
      return ctx.closes[index]!.greaterThan(emaNow);
    }
    case "CLOSE_BELOW_EMA": {
      const ema = getEma(ctx, rule.period);
      const emaNow = ema[index];
      if (emaNow == null) {
        return false;
      }
      return ctx.closes[index]!.lessThan(emaNow);
    }
  }
}

/**
 * Look-ahead-safe by construction, identical discipline to
 * evaluateEmaTrendPullback: deciding about index i only ever reads
 * candles[0..i] (calculateEma/calculateAtr are computed once over the
 * whole series, but index i of those arrays only depends on values[0..i]).
 * All of a definition's entryRules must be true (ANDed) for a signal.
 */
export function evaluateStrategyDefinition(
  candles: Candle[],
  definition: StrategyDefinition,
): StrategySignal[] {
  const parsed = strategyDefinitionSchema.parse(definition);
  const closes = candles.map((candle) => candle.close);
  const atr = calculateAtr(candles, parsed.atrPeriod);
  const ctx: RuleEvaluationContext = { index: 0, closes, emaCache: new Map() };

  const signals: StrategySignal[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    ctx.index = i;
    const atrNow = atr[i];
    if (atrNow == null) {
      continue;
    }

    const allRulesPass = parsed.entryRules.every((rule) => evaluateRule(rule, ctx));
    if (!allRulesPass) {
      continue;
    }

    const candle = candles[i] as Candle;
    signals.push({
      index: i,
      timestamp: candle.timestamp,
      direction: parsed.direction,
      closeAtSignal: closes[i] as Decimal,
      atrAtSignal: atrNow,
      entryReason: `StrategyDefinition v${parsed.version}: ${parsed.entryRules.map((r) => r.type).join(" AND ")}`,
    });
  }

  return signals;
}
