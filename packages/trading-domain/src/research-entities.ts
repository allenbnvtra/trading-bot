import Decimal from "decimal.js";

/**
 * Milestone 7: AI research agent + experiment framework (see
 * docs/ai-research.md, docs/research-methodology.md). Plain domain entities,
 * decoupled from Prisma's generated types, matching the convention in
 * entities.ts.
 */

export type AgentType = "RESEARCH";
export type AIProviderType = "MOCK" | "ANTHROPIC";
export type AgentExecutionStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export type HypothesisConfidence = "LOW" | "MEDIUM" | "HIGH";
export type ResearchHypothesisStatus =
  | "PROPOSED"
  | "EXPERIMENT_QUEUED"
  | "IN_PROGRESS"
  | "VALIDATED"
  | "REJECTED"
  | "ABANDONED";
export type ResearchExperimentStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type ResearchDatasetRole = "RESEARCH" | "VALIDATION" | "FINAL_TEST" | "WALK_FORWARD";

export interface AgentExecution {
  id: string;
  agentType: AgentType;
  provider: AIProviderType;
  model: string;
  promptVersion: string;
  inputSummary: Record<string, unknown>;
  outputRaw: string | null;
  outputParsed: Record<string, unknown> | null;
  status: AgentExecutionStatus;
  errorMessage: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: Decimal | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ResearchHypothesis {
  id: string;
  agentExecutionId: string;
  title: string;
  statement: string;
  rationale: string;
  confidence: HypothesisConfidence;
  sourceDataSummary: Record<string, unknown>;
  proposedStrategyDefinition: Record<string, unknown>;
  status: ResearchHypothesisStatus;
  createdAt: Date;
}

export interface ResearchExperiment {
  id: string;
  hypothesisId: string;
  datasetRole: ResearchDatasetRole;
  datasetWindowStart: Date;
  datasetWindowEnd: Date;
  backtestId: string | null;
  status: ResearchExperimentStatus;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
