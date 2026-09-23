import { z } from "zod";
import { TIMEFRAMES } from "./enums";

/**
 * Milestone 7 research-agent queue. attempts: 1 — an LLM call is neither
 * free nor safe to retry automatically (see docs/ai-research.md); a failed
 * AgentExecution is retried by a human triggering a fresh one via
 * POST /research/hypotheses/generate, mirroring SCREENSHOT_QUEUE's
 * deliberate attempts: 1 policy exactly.
 */
export const RESEARCH_AGENT_QUEUE = "research-agent-execution";
export const RUN_RESEARCH_AGENT_JOB = "run-research-agent";
export const RESEARCH_AGENT_JOB_OPTIONS = { attempts: 1 };

export interface ResearchAgentJobPayload {
  agentExecutionId: string;
}

export const AI_PROVIDER_TYPES = ["MOCK", "ANTHROPIC"] as const;
export type AIProviderType = (typeof AI_PROVIDER_TYPES)[number];

export const AGENT_EXECUTION_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED"] as const;
export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];

export const HYPOTHESIS_CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type HypothesisConfidence = (typeof HYPOTHESIS_CONFIDENCE_LEVELS)[number];

export const RESEARCH_HYPOTHESIS_STATUSES = [
  "PROPOSED",
  "EXPERIMENT_QUEUED",
  "IN_PROGRESS",
  "VALIDATED",
  "REJECTED",
  "ABANDONED",
] as const;
export type ResearchHypothesisStatus = (typeof RESEARCH_HYPOTHESIS_STATUSES)[number];

export const RESEARCH_EXPERIMENT_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED"] as const;
export type ResearchExperimentStatus = (typeof RESEARCH_EXPERIMENT_STATUSES)[number];

/** Order matters — see docs/research-methodology.md "The pipeline". */
export const RESEARCH_DATASET_ROLES = ["RESEARCH", "VALIDATION", "FINAL_TEST", "WALK_FORWARD"] as const;
export type ResearchDatasetRole = (typeof RESEARCH_DATASET_ROLES)[number];

/** Optional scope narrowing for which journal trades feed the ResearchAgent. Empty body = all available data. */
export const generateResearchHypothesisRequestSchema = z
  .object({
    strategyId: z.string().uuid().optional(),
    instrumentId: z.string().uuid().optional(),
  })
  .strict();
export type GenerateResearchHypothesisRequestInput = z.infer<typeof generateResearchHypothesisRequestSchema>;

export const createResearchExperimentRequestSchema = z
  .object({
    datasetRole: z.enum(RESEARCH_DATASET_ROLES),
    datasetWindowStart: z.string().datetime(),
    datasetWindowEnd: z.string().datetime(),
    instrumentId: z.string().uuid(),
    timeframe: z.enum(TIMEFRAMES),
    initialBalance: z.string(),
    riskPercentage: z.string(),
    slippageTicks: z.number().int().nonnegative(),
  })
  .strict();
export type CreateResearchExperimentRequestInput = z.infer<typeof createResearchExperimentRequestSchema>;

/**
 * A human-triggered action, never automatic — see CLAUDE.md "AI must never
 * directly modify an approved strategy" and the WALK_FORWARD-completion
 * requirement documented on ResearchService.markPaperCandidate.
 */
export const markPaperCandidateRequestSchema = z
  .object({
    confirmedByHuman: z.literal(true),
  })
  .strict();
export type MarkPaperCandidateRequestInput = z.infer<typeof markPaperCandidateRequestSchema>;
