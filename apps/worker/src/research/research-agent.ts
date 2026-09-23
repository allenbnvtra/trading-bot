import type { AIProvider, AIProviderResult, ResearchHypothesisOutput } from "@trading-copilot/ai-provider";
import type { ResearchDataSummary } from "@trading-copilot/analytics";

/**
 * Serializes every Decimal in a ResearchDataSummary to a plain string so
 * the AIProvider boundary never receives a Decimal instance. See
 * ResearchAgentPromptInput's doc comment in packages/ai-provider.
 */
function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "object" && "toFixed" in value && typeof (value as { toFixed: unknown }).toFixed === "function") {
    return (value as { toString(): string }).toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

/**
 * A ResearchDataSummary that has already been serialized to plain JSON
 * (for example, AgentExecution.inputSummary after a Prisma Json-column
 * round trip). Deliberately NOT typed as ResearchDataSummary: after the
 * round trip its Decimals are strings and there is no compile-time proof
 * of its shape, so claiming otherwise would be a lie to the type checker.
 * The provider boundary only ever needs JSON-safe data anyway (see
 * ResearchAgentPromptInput.summary), and the provider's own Zod parse of
 * its output is the trust boundary for what comes back.
 */
export type JsonSafeResearchSummary = Record<string, unknown>;

/**
 * Composes a deterministic ResearchDataSummary into a provider call and
 * hands back its validated result. Deliberately has no BullMQ or Prisma
 * dependency: AgentExecutionProcessor (Task 8) is the only caller, and it
 * owns all persistence. This class is pure orchestration and serialization,
 * unit-testable with MockAIProvider alone.
 */
export class ResearchAgent {
  constructor(private readonly provider: AIProvider) {}

  /**
   * Accepts either a live ResearchDataSummary (Decimal/Date values) or an
   * already JSON-safe one. toJsonSafe is idempotent over plain JSON (it
   * only rewrites Decimal-like and Date values), so both reach the
   * provider in the same serialized form.
   */
  async generateHypothesis(
    summary: ResearchDataSummary | JsonSafeResearchSummary,
  ): Promise<AIProviderResult<ResearchHypothesisOutput>> {
    const jsonSafeSummary = toJsonSafe(summary) as Record<string, unknown>;
    return this.provider.generateResearchHypothesis({ summary: jsonSafeSummary });
  }
}
