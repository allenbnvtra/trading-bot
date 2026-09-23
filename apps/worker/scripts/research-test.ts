/**
 * Manual, human-run verification of the mock-mode research pipeline end to
 * end against the real dev database (never run in CI/automated tests - see
 * docs/ai-research.md "Manual verification"). Mirrors
 * apps/worker/scripts/notification-test.ts's structure. Run with:
 *   pnpm --filter @trading-copilot/worker research:test
 */
import { researchRepository } from "@trading-copilot/database";
import { buildResearchDataSummary } from "@trading-copilot/analytics";
import { MockAIProvider } from "@trading-copilot/ai-provider";
import { ResearchAgent } from "../src/research/research-agent";

async function main() {
  console.log("Building a ResearchDataSummary from real journal data...");
  const trades = await researchRepository.listEnrichedJournalTradesForResearch({});
  const summary = buildResearchDataSummary(trades);
  console.log(`Sample: ${summary.overall.tradeCount} closed journal trades`);

  const execution = await researchRepository.createAgentExecution({
    agentType: "RESEARCH",
    provider: "MOCK",
    model: "mock-v1",
    promptVersion: "1.0.0",
    inputSummary: summary as unknown as Record<string, unknown>,
  });
  console.log(`Created AgentExecution ${execution.id}`);

  const agent = new ResearchAgent(new MockAIProvider());
  const result = await agent.generateHypothesis(summary);

  const hypothesis = await researchRepository.createResearchHypothesis({
    agentExecutionId: execution.id,
    title: result.output.title,
    statement: result.output.statement,
    rationale: result.output.rationale,
    confidence: result.output.confidence,
    sourceDataSummary: summary as unknown as Record<string, unknown>,
    proposedStrategyDefinition: result.output.proposedStrategyDefinition,
  });

  await researchRepository.markAgentExecutionSucceeded(execution.id, {
    outputRaw: result.rawResponse,
    outputParsed: result.output as unknown as Record<string, unknown>,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    costUsd: result.costUsd,
  });

  console.log(`Created ResearchHypothesis ${hypothesis.id}: "${hypothesis.title}"`);
  console.log("Done. Inspect it at GET /research/hypotheses/" + hypothesis.id);
}

main()
  .catch((error) => {
    console.error("research:test failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
