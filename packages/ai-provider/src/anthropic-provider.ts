import type Anthropic from "@anthropic-ai/sdk";
import Decimal from "decimal.js";
import { AI_PROVIDER_PROMPT_VERSION, researchHypothesisOutputSchema } from "./hypothesis-schema";
import type { AIProvider, AIProviderResult, ResearchAgentPromptInput } from "./types";

/**
 * Per-million-token pricing, update alongside AI_PROVIDER_PROMPT_VERSION
 * bumps if the configured model changes; kept as a named constant rather
 * than inline so cost tracking has one obvious place to audit.
 */
const INPUT_COST_PER_MILLION_TOKENS_USD = new Decimal(3);
const OUTPUT_COST_PER_MILLION_TOKENS_USD = new Decimal(15);

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
      proposedStrategyDefinition: { type: "object" },
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
  "CLOSE_ABOVE_EMA, and CLOSE_BELOW_EMA entry rule types. Call the propose_research_hypothesis tool " +
  "exactly once with your answer.";

function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

/** Real provider, never used by automated tests (see MockAIProvider); requires ANTHROPIC_API_KEY. */
export class AnthropicAIProvider implements AIProvider {
  readonly type = "ANTHROPIC" as const;

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async generateResearchHypothesis(
    input: ResearchAgentPromptInput,
  ): Promise<AIProviderResult<import("./hypothesis-schema").ResearchHypothesisOutput>> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [RESEARCH_HYPOTHESIS_TOOL],
      tool_choice: { type: "tool", name: RESEARCH_HYPOTHESIS_TOOL.name },
      messages: [{ role: "user", content: JSON.stringify(input.summary) }],
    });

    const toolUse = response.content.find(isToolUseBlock);
    const rawResponse = JSON.stringify(response.content);

    if (!toolUse) {
      throw new Error("AnthropicAIProvider: response contained no tool_use block");
    }

    // Zod validation is the trust boundary here, an invalid tool call
    // throws rather than being coerced into a guessed hypothesis. The
    // caller (AgentExecutionProcessor) catches this and marks the
    // AgentExecution FAILED with rawResponse preserved for audit.
    const output = researchHypothesisOutputSchema.parse(toolUse.input);

    const tokensInput = response.usage.input_tokens;
    const tokensOutput = response.usage.output_tokens;
    const costUsd = new Decimal(tokensInput)
      .dividedBy(1_000_000)
      .times(INPUT_COST_PER_MILLION_TOKENS_USD)
      .plus(new Decimal(tokensOutput).dividedBy(1_000_000).times(OUTPUT_COST_PER_MILLION_TOKENS_USD));

    return {
      output,
      rawResponse,
      promptVersion: AI_PROVIDER_PROMPT_VERSION,
      model: response.model,
      tokensInput,
      tokensOutput,
      costUsd,
    };
  }
}
