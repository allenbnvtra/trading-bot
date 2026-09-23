import type Decimal from "decimal.js";

/**
 * Thrown by a provider when a billed response came back but could not be
 * turned into a valid AIProviderResult (no tool_use block, or a tool call
 * that fails researchHypothesisOutputSchema). Carries everything the
 * caller needs to keep the failed call's audit trail: the raw response,
 * token usage, and the Decimal cost of the call, so a FAILED
 * AgentExecution row still records what was actually returned and what it
 * cost (and getTodayResearchSpend never undercounts a failed-but-billed
 * call).
 *
 * A failure with no response at all (a network error, an auth error, a
 * bug before the provider was ever called) is NOT this error type: there
 * is genuinely no raw response or usage to preserve in that case.
 */
export class AIProviderResponseError extends Error {
  readonly rawResponse: string;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly costUsd: Decimal;
  readonly model: string;
  readonly promptVersion: string;

  constructor(
    message: string,
    details: {
      rawResponse: string;
      tokensInput: number;
      tokensOutput: number;
      costUsd: Decimal;
      model: string;
      promptVersion: string;
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "AIProviderResponseError";
    this.rawResponse = details.rawResponse;
    this.tokensInput = details.tokensInput;
    this.tokensOutput = details.tokensOutput;
    this.costUsd = details.costUsd;
    this.model = details.model;
    this.promptVersion = details.promptVersion;
  }
}
