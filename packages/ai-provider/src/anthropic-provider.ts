import type Anthropic from "@anthropic-ai/sdk";
import Decimal from "decimal.js";
import { STRATEGY_DEFINITION_BOUNDS } from "@trading-copilot/strategy-engine";
import { AIProviderResponseError } from "./errors";
import {
  AI_PROVIDER_PROMPT_VERSION,
  researchHypothesisOutputSchema,
  type ResearchHypothesisOutput,
} from "./hypothesis-schema";
import type { AIProvider, AIProviderResult, ResearchAgentPromptInput } from "./types";

/**
 * Per-million-token pricing, update alongside AI_PROVIDER_PROMPT_VERSION
 * bumps if the configured model changes; kept as a named constant rather
 * than inline so cost tracking has one obvious place to audit.
 */
const INPUT_COST_PER_MILLION_TOKENS_USD = new Decimal(3);
const OUTPUT_COST_PER_MILLION_TOKENS_USD = new Decimal(15);

/**
 * Decimal-only cost of one call, shared by the success path and both
 * failure paths so a failed-but-billed call is costed identically to a
 * successful one.
 */
function computeCostUsd(tokensInput: number, tokensOutput: number): Decimal {
  return new Decimal(tokensInput)
    .dividedBy(1_000_000)
    .times(INPUT_COST_PER_MILLION_TOKENS_USD)
    .plus(new Decimal(tokensOutput).dividedBy(1_000_000).times(OUTPUT_COST_PER_MILLION_TOKENS_USD));
}

const PERIOD_JSON_SCHEMA = {
  type: "integer",
  minimum: STRATEGY_DEFINITION_BOUNDS.minPeriod,
  maximum: STRATEGY_DEFINITION_BOUNDS.maxPeriod,
} as const;

const ATR_MULTIPLIER_JSON_SCHEMA = {
  type: "number",
  minimum: STRATEGY_DEFINITION_BOUNDS.minAtrMultiplier,
  maximum: STRATEGY_DEFINITION_BOUNDS.maxAtrMultiplier,
} as const;

/**
 * Hand-written JSON-schema mirror of strategy-engine's
 * strategyDefinitionSchema, advertising its shape and
 * STRATEGY_DEFINITION_BOUNDS to the model so it proposes in-bounds values
 * up front. Guidance only: researchHypothesisOutputSchema.parse() below
 * remains the trust boundary, so any drift between this mirror and the Zod
 * schema can only cause a rejected (FAILED) call, never an accepted
 * invalid definition.
 */
const STRATEGY_DEFINITION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["1.0.0"] },
    direction: { type: "string", enum: ["LONG", "SHORT"] },
    entryRules: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["EMA_CROSS_ABOVE", "EMA_CROSS_BELOW", "CLOSE_ABOVE_EMA", "CLOSE_BELOW_EMA"] },
          fastPeriod: { ...PERIOD_JSON_SCHEMA, description: "Required for EMA_CROSS_ABOVE / EMA_CROSS_BELOW only." },
          slowPeriod: { ...PERIOD_JSON_SCHEMA, description: "Required for EMA_CROSS_ABOVE / EMA_CROSS_BELOW only." },
          period: { ...PERIOD_JSON_SCHEMA, description: "Required for CLOSE_ABOVE_EMA / CLOSE_BELOW_EMA only." },
        },
        required: ["type"],
      },
    },
    atrPeriod: PERIOD_JSON_SCHEMA,
    stopAtrMultiplier: ATR_MULTIPLIER_JSON_SCHEMA,
    targetAtrMultiplier: ATR_MULTIPLIER_JSON_SCHEMA,
  },
  required: ["version", "direction", "entryRules", "atrPeriod", "stopAtrMultiplier", "targetAtrMultiplier"],
} as const;

const RESEARCH_HYPOTHESIS_TOOL: Anthropic.Tool = {
  name: "propose_research_hypothesis",
  description: "Propose one testable trading-strategy research hypothesis from the given deterministic statistics.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      statement: { type: "string" },
      rationale: { type: "string" },
      confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      proposedStrategyDefinition: STRATEGY_DEFINITION_JSON_SCHEMA,
    },
    required: ["title", "statement", "rationale", "confidence", "proposedStrategyDefinition"],
  },
};

const SYSTEM_PROMPT =
  "You are a trading-strategy research assistant. You are given deterministic, already-computed " +
  "trade statistics (win rate, expectancy, averageR, profit factor, and breakdowns by session/" +
  "regime/direction), never raw price data. You do not calculate any P&L, risk, or performance " +
  "number yourself; you only interpret the numbers you are given. Propose exactly one testable " +
  "hypothesis, expressed as a StrategyDefinition using only the EMA_CROSS_ABOVE, EMA_CROSS_BELOW, " +
  "CLOSE_ABOVE_EMA, and CLOSE_BELOW_EMA entry rule types. Every EMA/ATR period must be an integer " +
  `from ${STRATEGY_DEFINITION_BOUNDS.minPeriod} to ${STRATEGY_DEFINITION_BOUNDS.maxPeriod}, and ` +
  `stopAtrMultiplier/targetAtrMultiplier must be from ${STRATEGY_DEFINITION_BOUNDS.minAtrMultiplier} ` +
  `to ${STRATEGY_DEFINITION_BOUNDS.maxAtrMultiplier}; out-of-bounds proposals are rejected. Call the ` +
  "propose_research_hypothesis tool exactly once with your answer.";

function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

/** Real provider, never used by automated tests (see MockAIProvider); requires ANTHROPIC_API_KEY. */
export class AnthropicAIProvider implements AIProvider {
  readonly type = "ANTHROPIC" as const;

  constructor(
    private readonly client: Anthropic,
    readonly model: string,
  ) {}

  async generateResearchHypothesis(input: ResearchAgentPromptInput): Promise<AIProviderResult<ResearchHypothesisOutput>> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [RESEARCH_HYPOTHESIS_TOOL],
      tool_choice: { type: "tool", name: RESEARCH_HYPOTHESIS_TOOL.name },
      messages: [{ role: "user", content: JSON.stringify(input.summary) }],
    });

    // From here on the call has been billed: every failure below throws an
    // AIProviderResponseError carrying the raw response, usage, and cost,
    // so the caller (AgentExecutionProcessor) can record all of it on the
    // FAILED AgentExecution row rather than losing the audit trail.
    const rawResponse = JSON.stringify(response.content);
    const tokensInput = response.usage.input_tokens;
    const tokensOutput = response.usage.output_tokens;
    const costUsd = computeCostUsd(tokensInput, tokensOutput);
    const audit = {
      rawResponse,
      tokensInput,
      tokensOutput,
      costUsd,
      model: response.model,
      promptVersion: AI_PROVIDER_PROMPT_VERSION,
    };

    const toolUse = response.content.find(isToolUseBlock);
    if (!toolUse) {
      throw new AIProviderResponseError("AnthropicAIProvider: response contained no tool_use block", audit);
    }

    // Zod validation is the trust boundary here, an invalid tool call
    // throws rather than being coerced into a guessed hypothesis.
    const parsed = researchHypothesisOutputSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new AIProviderResponseError(
        `AnthropicAIProvider: tool_use input failed schema validation: ${parsed.error.message}`,
        { ...audit, cause: parsed.error },
      );
    }

    return { output: parsed.data, ...audit };
  }
}
