import {
  emaTrendPullbackParametersSchema,
  evaluateEmaTrendPullback,
} from "./strategies/ema-trend-pullback";
import { evaluateStrategyDefinition, strategyDefinitionSchema } from "./strategies/strategy-definition";

/**
 * Registry of every strategy implementation keyed by Strategy.key, so
 * callers (the backtester, the API) can look up an evaluator + parameter
 * schema without hardcoding a switch statement. "ai-generated-dsl-v1" is
 * the single generic interpreter every AI-proposed hypothesis's
 * StrategyDefinition runs through: the ResearchAgent never generates or
 * registers new TypeScript code at runtime (see docs/ai-research.md
 * "Why a DSL, not generated code").
 */
export const STRATEGY_REGISTRY = {
  "ema-trend-pullback": {
    parametersSchema: emaTrendPullbackParametersSchema,
    evaluate: evaluateEmaTrendPullback,
  },
  "ai-generated-dsl-v1": {
    parametersSchema: strategyDefinitionSchema,
    evaluate: evaluateStrategyDefinition,
  },
} as const;

export type StrategyKey = keyof typeof STRATEGY_REGISTRY;
