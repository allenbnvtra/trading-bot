import { z } from "zod";
import { strategyDefinitionSchema } from "@trading-copilot/strategy-engine";

/**
 * Bumped whenever the required shape of a ResearchAgent output changes in a
 * way that should not silently reinterpret old AgentExecution.outputParsed
 * rows, mirrors NOTIFICATION_TEMPLATE_VERSION's role.
 */
export const AI_PROVIDER_PROMPT_VERSION = "1.0.0";

/**
 * What every AIProvider implementation must return, schema-validated
 * before it is ever persisted as a ResearchHypothesis. The AI proposes a
 * RESEARCH-stage hypothesis only, it never picks its own VALIDATION/
 * FINAL_TEST/WALK_FORWARD dataset (see docs/ai-research.md "Why the AI
 * never assigns its own test dataset").
 */
export const researchHypothesisOutputSchema = z
  .object({
    title: z.string().min(1).max(200),
    statement: z.string().min(1),
    rationale: z.string().min(1),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    proposedStrategyDefinition: strategyDefinitionSchema,
  })
  .strict();

export type ResearchHypothesisOutput = z.infer<typeof researchHypothesisOutputSchema>;
