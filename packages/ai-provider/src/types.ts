import Decimal from "decimal.js";
import type { ResearchHypothesisOutput } from "./hypothesis-schema";

/**
 * A pre-built deterministic summary (packages/analytics'
 * ResearchDataSummary, serialized to plain JSON-safe values), the only
 * thing a provider implementation ever sees. No raw candles, no Decimal
 * instances (already stringified by the caller), matching docs/ai-research.md
 * "The ResearchAgent consumes summaries, not millions of raw candles."
 */
export interface ResearchAgentPromptInput {
  summary: Record<string, unknown>;
}

export interface AIProviderResult<T> {
  output: T;
  rawResponse: string;
  promptVersion: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: Decimal;
}

export interface AIProvider {
  readonly type: "MOCK" | "ANTHROPIC";
  /**
   * The model this provider is configured to REQUEST. Known even when a
   * call fails with no response (network/auth error), so a FAILED audit
   * row can still say which model was attempted. When a response exists,
   * AIProviderResult.model (the model the API reports actually served the
   * call, e.g. a dated snapshot) is the authoritative value instead.
   */
  readonly model: string;
  generateResearchHypothesis(
    input: ResearchAgentPromptInput,
  ): Promise<AIProviderResult<ResearchHypothesisOutput>>;
}
