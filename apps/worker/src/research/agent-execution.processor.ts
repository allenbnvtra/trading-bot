import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, type Provider } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  AIProviderResponseError,
  type AIProvider,
  type AIProviderResult,
  type ResearchHypothesisOutput,
} from "@trading-copilot/ai-provider";
import { journalEventsRepository, researchRepository } from "@trading-copilot/database";
import { RESEARCH_AGENT_QUEUE, type ResearchAgentJobPayload } from "@trading-copilot/shared-types";
import { ResearchAgent } from "./research-agent";
import { createAIProviderFromEnv } from "./ai-provider.factory";

/**
 * No existing precedent in this codebase for a non-class NestJS injection
 * token other than SCREENSHOT_STORAGE_TOKEN / NOTIFICATION_PROVIDER_TOKEN
 * (see notification-send.processor.ts's own doc comment on
 * NOTIFICATION_PROVIDER_TOKEN) - AIProvider has the same problem (an
 * interface has no runtime value to use as a token, and which concrete
 * implementation to use, MockAIProvider vs. a future AnthropicAIProvider,
 * is an env-driven runtime decision), so this follows the same
 * plain-string-token pattern.
 *
 * researchRepository and journalEventsRepository are NOT injected this way:
 * confirmed against notification-send.processor.ts, this codebase's
 * repositories (notificationDeliveriesRepository, setupsRepository, etc.)
 * are plain exported objects from @trading-copilot/database, imported
 * directly as module-level singletons and called as
 * `someRepository.someMethod(...)`, never wired through NestJS DI or given
 * a string token. AgentExecutionProcessor follows that same convention
 * below; its test mocks the whole @trading-copilot/database module with
 * vi.mock, exactly as notification-send.processor.test.ts does.
 */
export const AI_PROVIDER = "AI_PROVIDER";

export const aiProviderProvider: Provider = {
  provide: AI_PROVIDER,
  useFactory: (): AIProvider => createAIProviderFromEnv(),
};

/**
 * Loads the RUNNING AgentExecution row written synchronously by
 * apps/api/src/research/research.service.ts BEFORE this job was enqueued
 * (so the audit trail exists even if this job never starts), calls
 * ResearchAgent, and persists the outcome. Never silently no-ops: a
 * missing AgentExecution row is a real bug (the row must exist before the
 * job can) and throws rather than swallowing.
 *
 * CLAUDE.md's "failed experiments and failed agent executions are never
 * deleted or hidden" applies here: the catch block always marks the
 * execution FAILED and records an AGENT_FAILED journal event before
 * rethrowing, so BullMQ's own logging still sees the failure (this queue's
 * RESEARCH_AGENT_JOB_OPTIONS.attempts is 1, see shared-types/src/research.ts,
 * so rethrowing never triggers an automatic retry, it just surfaces the
 * failure honestly rather than swallowing it).
 */
@Processor(RESEARCH_AGENT_QUEUE)
@Injectable()
export class AgentExecutionProcessor extends WorkerHost {
  constructor(@Inject(AI_PROVIDER) private readonly aiProvider: AIProvider) {
    super();
  }

  async process(job: Job<ResearchAgentJobPayload>): Promise<void> {
    const { agentExecutionId } = job.data;

    const execution = await researchRepository.getAgentExecution(agentExecutionId);
    if (!execution) {
      throw new Error(`AgentExecution ${agentExecutionId} not found: it must be created before enqueueing`);
    }

    // Held outside the try so the catch block can still audit a billed,
    // successful provider call whose downstream persistence failed.
    let result: AIProviderResult<ResearchHypothesisOutput> | undefined;

    try {
      await journalEventsRepository.createJournalEvent({
        eventType: "AGENT_STARTED",
        entityType: "AGENT_EXECUTION",
        entityId: agentExecutionId,
        metadata: { provider: this.aiProvider.type },
      });

      const agent = new ResearchAgent(this.aiProvider);
      // execution.inputSummary is a Json column round-tripped through
      // Prisma: plain JSON with no compile-time proof it is a
      // ResearchDataSummary, which is exactly what ResearchAgent's
      // JsonSafeResearchSummary parameter type accepts (no cast needed).
      result = await agent.generateHypothesis(execution.inputSummary);

      const hypothesis = await researchRepository.createResearchHypothesis({
        agentExecutionId,
        title: result.output.title,
        statement: result.output.statement,
        rationale: result.output.rationale,
        confidence: result.output.confidence,
        sourceDataSummary: execution.inputSummary,
        proposedStrategyDefinition: result.output.proposedStrategyDefinition,
      });

      await journalEventsRepository.createJournalEvent({
        eventType: "RESEARCH_HYPOTHESIS_CREATED",
        entityType: "RESEARCH_HYPOTHESIS",
        entityId: hypothesis.id,
        metadata: { agentExecutionId, confidence: hypothesis.confidence },
      });

      // provider/model/promptVersion come from the provider that actually
      // ran in THIS (worker) process, overwriting the API process's
      // creation-time guess, which may reflect a different env config.
      await researchRepository.markAgentExecutionSucceeded(agentExecutionId, {
        provider: this.aiProvider.type,
        model: result.model,
        promptVersion: result.promptVersion,
        outputRaw: result.rawResponse,
        outputParsed: result.output,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        costUsd: result.costUsd,
      });

      await journalEventsRepository.createJournalEvent({
        eventType: "AGENT_COMPLETED",
        entityType: "AGENT_EXECUTION",
        entityId: agentExecutionId,
        metadata: { hypothesisId: hypothesis.id },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await researchRepository.markAgentExecutionFailed(agentExecutionId, {
        errorMessage: message,
        ...this.describeBilledResponse(error, result),
      });
      await journalEventsRepository.createJournalEvent({
        eventType: "AGENT_FAILED",
        entityType: "AGENT_EXECUTION",
        entityId: agentExecutionId,
        metadata: { errorMessage: message },
      });

      throw error;
    }
  }

  /**
   * Whatever is known about a billed provider response at failure time, so
   * a FAILED row keeps the raw response, usage, cost, and the real
   * provider/model/promptVersion (and getTodayResearchSpend counts it).
   * Two cases carry a response: the provider itself rejected an unusable
   * response (AIProviderResponseError), or the provider succeeded and a
   * later persistence step failed (`result` is set). Anything else (a
   * network/auth error, or a bug before any provider call) genuinely has
   * no response, so outputRaw is null and usage is omitted; provider and
   * the configured (requested) model are still recorded, because this
   * worker process knows with certainty which provider it would have
   * called, and the API's creation-time guess may not match it.
   * promptVersion is left as created in that case: with no response there
   * is no provider-reported value to correct it with.
   */
  private describeBilledResponse(
    error: unknown,
    result: AIProviderResult<ResearchHypothesisOutput> | undefined,
  ): Omit<Parameters<typeof researchRepository.markAgentExecutionFailed>[1], "errorMessage"> {
    const billed = error instanceof AIProviderResponseError ? error : result;
    if (!billed) {
      return { outputRaw: null, provider: this.aiProvider.type, model: this.aiProvider.model };
    }
    return {
      outputRaw: billed.rawResponse,
      tokensInput: billed.tokensInput,
      tokensOutput: billed.tokensOutput,
      costUsd: billed.costUsd,
      provider: this.aiProvider.type,
      model: billed.model,
      promptVersion: billed.promptVersion,
    };
  }
}
