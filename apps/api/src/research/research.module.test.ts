import { describe, expect, it, vi } from "vitest";
import { getQueueOptionsToken } from "@nestjs/bullmq";
import { RESEARCH_AGENT_JOB_OPTIONS, RESEARCH_AGENT_QUEUE } from "@trading-copilot/shared-types";

// ResearchService imports @trading-copilot/database at module load; nothing
// here touches a repository, so an empty stand-in avoids a Prisma client.
vi.mock("@trading-copilot/database", () => ({}));

import { ResearchModule } from "./research.module";

interface FactoryProvider {
  provide: unknown;
  useFactory: (holder: { getDependencyRef: (name: string) => Record<string, unknown> }) => Record<string, unknown>;
}

interface DynamicModuleLike {
  providers?: unknown[];
}

function isFactoryProvider(provider: unknown): provider is FactoryProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "provide" in provider &&
    "useFactory" in provider &&
    typeof (provider as { useFactory: unknown }).useFactory === "function"
  );
}

/**
 * BullMQ's defaultJobOptions only apply to jobs added through the Queue
 * instance they were registered on. ResearchService.generateHypothesis adds
 * the research-agent job through THIS module's Queue (not the worker's), so
 * the attempts: 1 policy must be registered here. This resolves the actual
 * queue-options provider BullModule.registerQueue produced for
 * ResearchModule, rather than re-reading a constant.
 */
describe("ResearchModule", () => {
  it("registers RESEARCH_AGENT_QUEUE with RESEARCH_AGENT_JOB_OPTIONS on the enqueueing (API) side", () => {
    const imports = Reflect.getMetadata("imports", ResearchModule) as DynamicModuleLike[];
    const optionsToken = getQueueOptionsToken(RESEARCH_AGENT_QUEUE);
    const optionsProvider = imports
      .flatMap((imported) => imported.providers ?? [])
      .filter(isFactoryProvider)
      .find((provider) => provider.provide === optionsToken);

    expect(optionsProvider, "expected BullModule.registerQueue for RESEARCH_AGENT_QUEUE").toBeDefined();
    const resolved = optionsProvider!.useFactory({ getDependencyRef: () => ({}) });

    expect(resolved.name).toBe(RESEARCH_AGENT_QUEUE);
    expect(resolved.defaultJobOptions).toEqual(RESEARCH_AGENT_JOB_OPTIONS);
    expect(RESEARCH_AGENT_JOB_OPTIONS.attempts).toBe(1);
  });
});
