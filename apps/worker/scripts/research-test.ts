/**
 * Manual, human-run verification of the mock-mode research pipeline end to
 * end against the real dev database (never run in CI/automated tests - see
 * docs/ai-research.md "Manual verification"). Mirrors
 * apps/worker/scripts/notification-test.ts's structure. Run with:
 *   pnpm --filter @trading-copilot/worker research:test
 *
 * Drives the real AgentExecutionProcessor (not a hand-rolled copy of its
 * steps) so this script actually exercises - and can be used to verify -
 * the full pipeline's side effects, including every JournalEvent the
 * processor emits (AGENT_STARTED, RESEARCH_HYPOTHESIS_CREATED,
 * AGENT_COMPLETED). An earlier version of this script called
 * researchRepository/ResearchAgent directly and silently produced zero
 * journal events, since it bypassed the processor entirely.
 */
import type { Job } from "bullmq";
import { researchRepository } from "@trading-copilot/database";
import { buildResearchDataSummary } from "@trading-copilot/analytics";
import { MockAIProvider } from "@trading-copilot/ai-provider";
import type { ResearchAgentJobPayload } from "@trading-copilot/shared-types";
import { AgentExecutionProcessor } from "../src/research/agent-execution.processor";

async function main() {
  console.log("Building a ResearchDataSummary from real journal data...");
  const trades = await researchRepository.listEnrichedJournalTradesForResearch({});
  const summary = buildResearchDataSummary(trades);
  console.log(`Sample: ${summary.overall.tradeCount} closed journal trades`);

  // Mirrors what apps/api/src/research/research.service.ts's
  // generateHypothesis does before enqueueing: create the RUNNING
  // AgentExecution row synchronously, so the audit trail exists even if
  // the job never starts.
  const execution = await researchRepository.createAgentExecution({
    agentType: "RESEARCH",
    provider: "MOCK",
    model: "mock-v1",
    promptVersion: "1.0.0",
    inputSummary: summary as unknown as Record<string, unknown>,
  });
  console.log(`Created AgentExecution ${execution.id}`);

  const processor = new AgentExecutionProcessor(new MockAIProvider());
  const job = { data: { agentExecutionId: execution.id } } as Job<ResearchAgentJobPayload>;
  await processor.process(job);

  const succeeded = await researchRepository.getAgentExecution(execution.id);
  const hypotheses = await researchRepository.listResearchHypotheses();
  const hypothesis = hypotheses.find((h) => h.agentExecutionId === execution.id);

  console.log(`AgentExecution ${execution.id} status: ${succeeded?.status}`);
  if (hypothesis) {
    console.log(`Created ResearchHypothesis ${hypothesis.id}: "${hypothesis.title}"`);
    console.log("Done. Inspect it at GET /research/hypotheses/" + hypothesis.id);
  } else {
    console.log("No ResearchHypothesis found for this execution - check AgentExecution.errorMessage.");
  }
}

main()
  .catch((error) => {
    console.error("research:test failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
