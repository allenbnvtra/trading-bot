# Milestone 7 — AI Research Agent + Experiment Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a research system that turns deterministic journal/backtest statistics into AI-generated, schema-validated, testable hypotheses — each hypothesis becomes a deterministic `StrategyDefinition`, which the existing `packages/backtester` runs unchanged through research → validation → final-test → walk-forward-foundation stages, with every AI call, dataset assignment, and experiment outcome durably audited. AI never calculates a P&L/risk number and never modifies an approved `StrategyVersion`; a human always decides what happens with a result. No live agents (Structure/Regime/Critic/Event), no live READY/REJECT decisions, no broker execution.

**Architecture:** A new framework-independent `packages/ai-provider` package defines the `AIProvider` interface (`MockAIProvider` for deterministic tests/CI, `AnthropicAIProvider` for real calls, env-gated) and the Zod schema for a structured hypothesis output — it has no database dependency, so it cannot leak raw trading data anywhere except into a prompt string it is handed. `apps/worker` owns a `ResearchAgent` class that assembles a deterministic `ResearchDataSummary` (from a new `packages/analytics` module, itself built on the existing `calculateTradeAnalytics`/journal data) into a prompt, calls the injected `AIProvider`, and validates the result — this class is unit-testable with `MockAIProvider` and has no BullMQ dependency. A thin `AgentExecutionProcessor` wires that class into BullMQ, persisting an `AgentExecution` audit row before and after every call. `apps/api` owns hypothesis/experiment CRUD, budget enforcement, dataset-role stage ordering, and the final-test reuse safeguard (a partial unique database index — not a check-then-insert). A `StrategyDefinition` — a small, safe, schema-validated rule DSL generalizing `ema-trend-pullback.ts`'s existing EMA-cross-with-ATR-stop shape — is interpreted by a new deterministic evaluator registered in the existing `STRATEGY_REGISTRY`, so an AI-proposed strategy runs through `runBacktest` completely unchanged; the backtester's own type signature is widened (not rewritten) to accept any registered strategy key generically. `apps/dashboard` gets a read-only research area (list + detail pages) following the existing App Router / `lib/api.ts` / "no financial logic in components" conventions.

**Tech Stack:** TypeScript, NestJS, Next.js (App Router), Prisma/PostgreSQL, BullMQ/Redis, Zod, decimal.js, Vitest, `@anthropic-ai/sdk` (new dependency, `packages/ai-provider` only).

**Spec:** This plan implements the Milestone 7 kickoff brief (verbatim spec pasted into this session: "Milestone 7 — AI Research Agent + Experiment Framework"), cross-referenced against `docs/research-methodology.md` (pipeline, final-test-dataset rule, sample-size guardrails, "AI does not calculate"), `docs/backtesting-assumptions.md` (the exact simulation rules any `StrategyDefinition` interpreter must produce output compatible with), and `CLAUDE.md` (subagent ownership, financial-determinism rules, no automatic execution). It assumes Milestone 6 and the post-Milestone-6 technical-debt pass are already merged to `main` (commit `d186725`).

## Global Constraints

- AI never produces an authoritative P&L/risk number. Every dollar/R/win-rate figure a hypothesis references comes from `packages/analytics`/`packages/backtester`/`packages/risk-engine`, computed before the AI call, and is only *read* by the AI provider — never recomputed or overridden by it.
- AI never directly modifies an `APPROVED` (or any existing) `StrategyVersion`. A hypothesis always proposes a brand-new `StrategyDefinition`; turning that into a `StrategyVersion` always creates a new row (`status: DISCOVERED`), mirroring the existing "`StrategyVersion` rows are immutable, there is no update function" rule.
- `MockAIProvider` must be fully deterministic (same input → byte-identical output) and require zero network access, zero API keys — it is the default provider whenever `ANTHROPIC_API_KEY` is unset, and it is what automated tests and CI always use.
- Every AI call is durably audited in `AgentExecution` (provider, model, prompt version, raw response, parsed response, tokens, cost, status) before the calling code can act on the result. A call that fails to parse into the schema is recorded as `FAILED` with the raw response preserved — never silently discarded, never guessed into a partial hypothesis.
- The final-test dataset for a given hypothesis is not renewable: at most one live (non-`FAILED`) `ResearchExperiment` with `datasetRole = FINAL_TEST` may exist per hypothesis, enforced by a database constraint (a partial unique index, following the exact `journal-trades.ts`/`trade-screenshots.ts` precedent from the post-Milestone-6 technical-debt pass), never a check-then-insert.
- Dataset-role stages advance in order (`RESEARCH → VALIDATION → FINAL_TEST → WALK_FORWARD`) and only after the prior stage has a `COMPLETED` experiment — enforced in the API service layer, checked before every experiment-creation call.
- Sample-size guardrails (`>= 60 calendar days` AND `>= 100 candidate setups`, both required) gate `VALIDATION`/`FINAL_TEST`/`WALK_FORWARD` experiment creation and the `PAPER_CANDIDATE` status transition — computed by a pure function, never bypassed silently.
- Failed experiments and failed agent executions are never deleted or hidden. No delete/update-in-place repository function is exposed for `AgentExecution`, `ResearchHypothesis`, or `ResearchExperiment` beyond documented status transitions.
- No automatic broker execution anywhere in this plan (`buy`/`sell`/`placeOrder`/`cancelOrder`/`modifyOrder`/broker credentials). No `StructureAgent`/`RegimeAgent`/`CriticAgent`/`EventAgent`, no live READY/REJECT decision logic. `PAPER_CANDIDATE` is reached only by an explicit human-triggered API call reviewing completed experiment results — nothing auto-promotes a `StrategyVersion`.
- Strict TypeScript, no `any`. Validate all external input with Zod. Keep controllers thin. `packages/ai-provider` has zero dependency on `packages/database`, NestJS, or BullMQ — it is a pure provider abstraction, matching `packages/risk-engine`'s existing framework-independence.
- BullMQ job enqueuing for the research-agent queue uses `attempts: 1` (mirrors `SCREENSHOT_QUEUE`'s precedent, doc-commented): an LLM call is neither free nor idempotent to retry automatically, so a failed `AgentExecution` is retried by a human triggering a fresh one, never by BullMQ's own backoff.
- Do not introduce Kubernetes, Kafka, or microservices. Reuse the existing BullMQ/Redis stack and the existing `BACKTEST_RUN_QUEUE`/`BacktestRunProcessor` for every experiment's backtest — a `ResearchExperiment` creates a normal `Backtest` row and reuses the unmodified backtest pipeline, it does not duplicate it.

---

## File Structure

- **Modify** `packages/database/prisma/schema.prisma` — `ResearchHypothesis`, `ResearchExperiment`, `AgentExecution`, `HypothesisConfidence` model/enums; `StrategyVersionStatus` gains `PAPER_CANDIDATE`; `StrategyVersion` gains `sourceHypothesisId`; `Backtest` gains the `researchExperiment` back-relation; `JournalEventType`/`JournalEntityType` additions; hand-written partial unique index migration for final-test reuse.
- **Modify** `packages/trading-domain/src/entities.ts` — `StrategyVersion.sourceHypothesisId`.
- **Create** `packages/trading-domain/src/research-entities.ts` — `ResearchHypothesis`, `ResearchExperiment`, `AgentExecution` interfaces.
- **Modify** `packages/database/src/mappers.ts` — `mapResearchHypothesis`, `mapResearchExperiment`, `mapAgentExecution`.
- **Create** `packages/shared-types/src/research.ts` — queue/job constants, value-array enums, request Zod schemas.
- **Modify** `packages/shared-types/src/enums.ts` — `STRATEGY_VERSION_STATUSES` gains `PAPER_CANDIDATE`.
- **Create** `packages/strategy-engine/src/strategies/strategy-definition.ts` — `strategyDefinitionSchema`, `evaluateStrategyDefinition`.
- **Modify** `packages/strategy-engine/src/strategies/ema-trend-pullback.ts` — `StrategySignal` moves to a shared file; `STRATEGY_REGISTRY` moves out.
- **Create** `packages/strategy-engine/src/types.ts` — shared `StrategySignal`.
- **Create** `packages/strategy-engine/src/registry.ts` — merged `STRATEGY_REGISTRY`, `StrategyKey`.
- **Modify** `packages/strategy-engine/src/index.ts`.
- **Modify** `packages/backtester/src/engine.ts` — `BacktestRunInput<K>` generic widening, `AtrStopTargetParameters`.
- **Create** `packages/analytics/src/research-summary.ts` — `buildResearchDataSummary`, `assertSampleSizeGuardrails`.
- **Create** `packages/analytics/src/parameter-sensitivity.ts` — `compareParameterVariations`.
- **Create** `packages/analytics/src/walk-forward.ts` — `generateWalkForwardWindows`.
- **Modify** `packages/analytics/src/index.ts`.
- **Modify** `packages/database/src/errors.ts` — `FinalTestAlreadySpentError`, `ResearchStageOrderError`, `ResearchBudgetExceededError`.
- **Create** `packages/database/src/repositories/research.ts` — hypothesis/experiment/agent-execution persistence, `listEnrichedJournalTradesForResearch`, budget queries.
- **Create** `packages/ai-provider/` (new package) — `AIProvider` interface, `MockAIProvider`, `AnthropicAIProvider`, `ResearchHypothesisOutput` schema, provider factory.
- **Create** `apps/worker/src/research/research-agent.ts` — `ResearchAgent`.
- **Create** `apps/worker/src/research/agent-execution.processor.ts`.
- **Modify** `apps/worker/src/app.module.ts` — register `RESEARCH_AGENT_QUEUE` + providers.
- **Create** `apps/api/src/research/research.module.ts`, `research.service.ts`, `research.controller.ts`.
- **Modify** `apps/api/src/app.module.ts` — register `ResearchModule`.
- **Modify** `apps/api/src/common/domain-error.filter.ts` — catch the new research errors.
- **Create** `apps/dashboard/src/app/(dashboard)/research/page.tsx`, `apps/dashboard/src/app/(dashboard)/research/[id]/page.tsx`.
- **Modify** `apps/dashboard/src/lib/api.ts`.
- **Modify** `.env.example`, `turbo.json` (new `RESEARCH_*`/`ANTHROPIC_*` env pass-through), `docs/implementation-status.md`, `docs/roadmap.md`, `docs/research-methodology.md`, `docs/architecture.md`.
- **Create** `docs/ai-research.md`.

---

## Phase A — Shared contracts (sequential; everything else depends on this landing first)

### Task 1: Schema — ResearchHypothesis, ResearchExperiment, AgentExecution, PAPER_CANDIDATE, final-test reuse index

**Owner:** data-engineer

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/trading-domain/src/entities.ts`
- Create: `packages/trading-domain/src/research-entities.ts`
- Modify: `packages/trading-domain/src/index.ts`
- Modify: `packages/database/src/mappers.ts`
- Test: `packages/database/src/mappers.test.ts`

**Interfaces:**
- Produces: Prisma enums `HypothesisConfidence` (`LOW | MEDIUM | HIGH`), `ResearchHypothesisStatus` (`PROPOSED | EXPERIMENT_QUEUED | IN_PROGRESS | VALIDATED | REJECTED | ABANDONED`), `ResearchExperimentStatus` (`QUEUED | RUNNING | COMPLETED | FAILED`), `ResearchDatasetRole` (`RESEARCH | VALIDATION | FINAL_TEST | WALK_FORWARD`), `AgentType` (`RESEARCH`), `AIProviderType` (`MOCK | ANTHROPIC`), `AgentExecutionStatus` (`RUNNING | SUCCEEDED | FAILED`). Prisma models `ResearchHypothesis`, `ResearchExperiment`, `AgentExecution`. `StrategyVersionStatus` gains `PAPER_CANDIDATE` between `WALK_FORWARD` and `PAPER_TRADING`. `StrategyVersion.sourceHypothesisId String?`. `mapResearchHypothesis(row): ResearchHypothesis`, `mapResearchExperiment(row): ResearchExperiment`, `mapAgentExecution(row): AgentExecution` in `packages/database/src/mappers.ts`.

- [ ] **Step 1: Write the failing mapper tests**

```typescript
// packages/database/src/mappers.test.ts — add to the existing file
describe("mapAgentExecution", () => {
  it("maps every field, including nullable ones, without fabricating defaults", () => {
    const row = {
      id: "exec-1",
      agentType: "RESEARCH" as const,
      provider: "MOCK" as const,
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: { tradeCount: 10 },
      outputRaw: '{"title":"x"}',
      outputParsed: { title: "x" },
      status: "SUCCEEDED" as const,
      errorMessage: null,
      tokensInput: 120,
      tokensOutput: 340,
      costUsd: new Prisma.Decimal("0.0021"),
      startedAt: new Date("2026-09-23T00:00:00Z"),
      completedAt: new Date("2026-09-23T00:00:05Z"),
    };

    expect(mapAgentExecution(row)).toEqual({
      id: "exec-1",
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: { tradeCount: 10 },
      outputRaw: '{"title":"x"}',
      outputParsed: { title: "x" },
      status: "SUCCEEDED",
      errorMessage: null,
      tokensInput: 120,
      tokensOutput: 340,
      costUsd: new Decimal("0.0021"),
      startedAt: new Date("2026-09-23T00:00:00Z"),
      completedAt: new Date("2026-09-23T00:00:05Z"),
    });
  });
});

describe("mapResearchHypothesis", () => {
  it("maps every field, including nullable ones", () => {
    const row = {
      id: "hyp-1",
      agentExecutionId: "exec-1",
      title: "EMA pullback in low-vol regime",
      statement: "Long entries after a fast/slow EMA cross show higher averageR in LOW volume regime candles.",
      rationale: "Winners had 18% lower average volumePercentile than losers in the sample.",
      confidence: "MEDIUM" as const,
      sourceDataSummary: { tradeCount: 140 },
      proposedStrategyDefinition: { version: "1.0.0" },
      status: "PROPOSED" as const,
      createdAt: new Date("2026-09-23T00:00:06Z"),
    };

    expect(mapResearchHypothesis(row)).toEqual({
      id: "hyp-1",
      agentExecutionId: "exec-1",
      title: "EMA pullback in low-vol regime",
      statement: "Long entries after a fast/slow EMA cross show higher averageR in LOW volume regime candles.",
      rationale: "Winners had 18% lower average volumePercentile than losers in the sample.",
      confidence: "MEDIUM",
      sourceDataSummary: { tradeCount: 140 },
      proposedStrategyDefinition: { version: "1.0.0" },
      status: "PROPOSED",
      createdAt: new Date("2026-09-23T00:00:06Z"),
    });
  });
});

describe("mapResearchExperiment", () => {
  it("maps every field, including nullable ones", () => {
    const row = {
      id: "expr-1",
      hypothesisId: "hyp-1",
      datasetRole: "RESEARCH" as const,
      datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-03-01T00:00:00Z"),
      backtestId: null,
      status: "QUEUED" as const,
      failureReason: null,
      createdAt: new Date("2026-09-23T00:00:07Z"),
      completedAt: null,
    };

    expect(mapResearchExperiment(row)).toEqual({
      id: "expr-1",
      hypothesisId: "hyp-1",
      datasetRole: "RESEARCH",
      datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-03-01T00:00:00Z"),
      backtestId: null,
      status: "QUEUED",
      failureReason: null,
      createdAt: new Date("2026-09-23T00:00:07Z"),
      completedAt: null,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @trading-copilot/database test -- mappers`
Expected: FAIL — `mapAgentExecution`/`mapResearchHypothesis`/`mapResearchExperiment` are not exported, `Prisma` may need importing in the test file (check the existing top-of-file import; add `Prisma` from `@prisma/client` if not already imported).

- [ ] **Step 3: Update the Prisma schema — new enums**

Add near the other research/lifecycle enums in `packages/database/prisma/schema.prisma` (after `StrategyVersionStatus`):

```prisma
// Milestone 7. Confidence the ResearchAgent itself expressed for a
// hypothesis — an AI self-report, not a statistical measure. Never used as
// an input to any deterministic calculation; display/filter only.
enum HypothesisConfidence {
  LOW
  MEDIUM
  HIGH
}

enum ResearchHypothesisStatus {
  PROPOSED
  EXPERIMENT_QUEUED
  IN_PROGRESS
  VALIDATED
  REJECTED
  ABANDONED
}

enum ResearchExperimentStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
}

// See docs/research-methodology.md "The pipeline". Stages advance in this
// order and only after the prior stage has a COMPLETED experiment — enforced
// in apps/api/src/research/research.service.ts, not at the database layer
// (the database layer only enforces the final-test reuse rule below, via a
// partial unique index — see ResearchExperiment's own doc comment).
enum ResearchDatasetRole {
  RESEARCH
  VALIDATION
  FINAL_TEST
  WALK_FORWARD
}

// Reserved for future runtime agents (StructureAgent, RegimeAgent,
// CriticAgent, EventAgent — see docs/roadmap.md). Milestone 7 only ever
// creates RESEARCH rows; do not pre-add the others until those agents
// actually exist, matching the JournalEventType convention below.
enum AgentType {
  RESEARCH
}

enum AIProviderType {
  MOCK
  ANTHROPIC
}

enum AgentExecutionStatus {
  RUNNING
  SUCCEEDED
  FAILED
}
```

Insert `PAPER_CANDIDATE` into the existing `StrategyVersionStatus` enum:

```prisma
enum StrategyVersionStatus {
  DISCOVERED
  BACKTESTING
  VALIDATION
  OUT_OF_SAMPLE
  WALK_FORWARD
  PAPER_CANDIDATE
  PAPER_TRADING
  APPROVED
  PAUSED
  RETIRED
}
```

- [ ] **Step 4: Add the new models**

```prisma
// Milestone 7. One row per AI provider call. Written RUNNING before the
// call, then SUCCEEDED/FAILED after — so a crash mid-call still leaves an
// audit row, never a silently-missing one. outputRaw preserves the exact
// provider response text even when outputParsed/schema validation failed,
// so a FAILED row is still inspectable, never a wasted call with no trace.
// No delete/update-in-place function is exposed beyond the documented
// status transitions — see repositories/research.ts.
model AgentExecution {
  id String @id @default(uuid())

  agentType     AgentType      @default(RESEARCH)
  provider      AIProviderType
  model         String
  promptVersion String

  // Deterministic ResearchDataSummary (or subset) the prompt was built
  // from — persisted so a human can see exactly what data the AI saw,
  // without re-deriving it later from possibly-changed journal data.
  inputSummary Json

  outputRaw    String?
  outputParsed Json?

  status       AgentExecutionStatus @default(RUNNING)
  errorMessage String?

  tokensInput  Int?
  tokensOutput Int?
  costUsd      Decimal? @db.Decimal(10, 4)

  startedAt   DateTime  @default(now())
  completedAt DateTime?

  hypothesis ResearchHypothesis?

  @@index([status])
  @@index([startedAt])
}

// Milestone 7. A structured, schema-validated output of a SUCCEEDED
// AgentExecution. agentExecutionId is @unique — a hypothesis always traces
// to exactly one originating call, never fabricated without one.
model ResearchHypothesis {
  id               String         @id @default(uuid())
  agentExecutionId String         @unique
  agentExecution   AgentExecution @relation(fields: [agentExecutionId], references: [id])

  title     String
  statement String
  rationale String

  confidence HypothesisConfidence

  // The ResearchDataSummary this hypothesis was derived from (duplicated
  // from AgentExecution.inputSummary for convenient querying without a
  // join — both are append-only so there is no drift risk).
  sourceDataSummary Json

  // A schema-validated StrategyDefinition JSON document (see
  // packages/strategy-engine/src/strategies/strategy-definition.ts). Not a
  // StrategyVersion yet — that is only created once a human requests a
  // RESEARCH-stage experiment (see ResearchService.createExperiment).
  proposedStrategyDefinition Json

  status ResearchHypothesisStatus @default(PROPOSED)

  createdAt DateTime @default(now())

  experiments      ResearchExperiment[]
  strategyVersions StrategyVersion[]

  @@index([status])
}

// Milestone 7. One row per dataset-stage attempt at testing a hypothesis's
// proposed strategy. backtestId links to a normal Backtest row — the
// existing, unmodified backtest pipeline is reused entirely; this model
// never duplicates backtest logic.
//
// Final-test reuse safeguard (docs/research-methodology.md "The final test
// dataset is not renewable"): at most one non-FAILED FINAL_TEST experiment
// may exist per hypothesis. Prisma's schema DSL cannot express a partial
// (WHERE-clause) unique index, so this is a hand-written migration.sql
// (see the migration created in this task) — DO NOT "clean this up" into a
// plain @@unique([hypothesisId, datasetRole]), which would also forbid two
// FAILED attempts or a RESEARCH+VALIDATION pair, both legitimate.
model ResearchExperiment {
  id String @id @default(uuid())

  hypothesisId String
  hypothesis   ResearchHypothesis @relation(fields: [hypothesisId], references: [id], onDelete: Cascade)

  datasetRole        ResearchDatasetRole
  datasetWindowStart DateTime
  datasetWindowEnd   DateTime

  backtestId String?   @unique
  backtest   Backtest? @relation(fields: [backtestId], references: [id])

  status        ResearchExperimentStatus @default(QUEUED)
  failureReason String?

  createdAt   DateTime  @default(now())
  completedAt DateTime?

  @@index([hypothesisId])
  @@index([status])
}
```

Add `sourceHypothesisId` to `StrategyVersion` (near its other fields) and the reverse relation:

```prisma
model StrategyVersion {
  // ... existing fields ...

  // Milestone 7. Set only when this version originated from an AI-proposed
  // hypothesis (see ResearchHypothesis.proposedStrategyDefinition). Null
  // for every hand-authored version, including the Milestone 1 example
  // strategy. A version with this set is never edited in place — the
  // existing "StrategyVersion rows are immutable" rule is unchanged.
  sourceHypothesisId String?
  sourceHypothesis   ResearchHypothesis? @relation(fields: [sourceHypothesisId], references: [id])
}
```

Add the reverse relation to `Backtest`:

```prisma
model Backtest {
  // ... existing fields ...
  researchExperiment ResearchExperiment?
}
```

Add to `JournalEventType` (near the existing "Milestone 6+" comment, replacing it):

```prisma
  // Milestone 7 — AI research agent + experiment framework. See
  // docs/ai-research.md.
  AGENT_STARTED
  AGENT_COMPLETED
  AGENT_FAILED
  RESEARCH_HYPOTHESIS_CREATED
  RESEARCH_EXPERIMENT_CREATED
  RESEARCH_EXPERIMENT_COMPLETED
  STRATEGY_VERSION_STATUS_CHANGED
```

Add to `JournalEntityType`: `AGENT_EXECUTION`, `RESEARCH_HYPOTHESIS`, `RESEARCH_EXPERIMENT`.

- [ ] **Step 5: Generate the migration, then hand-edit in the partial unique index**

Run: `pnpm --filter @trading-copilot/database exec prisma migrate dev --name add_research_agent_framework --create-only`

Open the generated `packages/database/prisma/migrations/<timestamp>_add_research_agent_framework/migration.sql` and append, after the generated `CREATE TABLE`/`CREATE INDEX` statements:

```sql
-- Final-test reuse safeguard: at most one non-FAILED FINAL_TEST experiment
-- per hypothesis. See ResearchExperiment's doc comment in schema.prisma —
-- do not replace this with a plain unique constraint.
CREATE UNIQUE INDEX "ResearchExperiment_hypothesis_final_test_key"
  ON "ResearchExperiment" ("hypothesisId")
  WHERE "datasetRole" = 'FINAL_TEST' AND "status" IN ('QUEUED', 'RUNNING', 'COMPLETED');
```

Run: `pnpm --filter @trading-copilot/database exec prisma migrate dev`
Expected: migration applies cleanly against the local dev database.

- [ ] **Step 6: Add trading-domain interfaces**

```typescript
// packages/trading-domain/src/research-entities.ts
import Decimal from "decimal.js";

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
```

Modify `packages/trading-domain/src/entities.ts`'s `StrategyVersion` interface to add `sourceHypothesisId: string | null;` and modify `packages/trading-domain/src/index.ts` to add `export * from "./research-entities";`.

- [ ] **Step 7: Implement the mappers**

```typescript
// packages/database/src/mappers.ts — add
import type { AgentExecution, ResearchExperiment, ResearchHypothesis } from "@trading-copilot/trading-domain";

export function mapAgentExecution(row: {
  id: string;
  agentType: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputSummary: Prisma.JsonValue;
  outputRaw: string | null;
  outputParsed: Prisma.JsonValue | null;
  status: string;
  errorMessage: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: Prisma.Decimal | null;
  startedAt: Date;
  completedAt: Date | null;
}): AgentExecution {
  return {
    id: row.id,
    agentType: row.agentType as AgentExecution["agentType"],
    provider: row.provider as AgentExecution["provider"],
    model: row.model,
    promptVersion: row.promptVersion,
    inputSummary: row.inputSummary as Record<string, unknown>,
    outputRaw: row.outputRaw,
    outputParsed: row.outputParsed as Record<string, unknown> | null,
    status: row.status as AgentExecution["status"],
    errorMessage: row.errorMessage,
    tokensInput: row.tokensInput,
    tokensOutput: row.tokensOutput,
    costUsd: row.costUsd ? new Decimal(row.costUsd.toString()) : null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export function mapResearchHypothesis(row: {
  id: string;
  agentExecutionId: string;
  title: string;
  statement: string;
  rationale: string;
  confidence: string;
  sourceDataSummary: Prisma.JsonValue;
  proposedStrategyDefinition: Prisma.JsonValue;
  status: string;
  createdAt: Date;
}): ResearchHypothesis {
  return {
    id: row.id,
    agentExecutionId: row.agentExecutionId,
    title: row.title,
    statement: row.statement,
    rationale: row.rationale,
    confidence: row.confidence as ResearchHypothesis["confidence"],
    sourceDataSummary: row.sourceDataSummary as Record<string, unknown>,
    proposedStrategyDefinition: row.proposedStrategyDefinition as Record<string, unknown>,
    status: row.status as ResearchHypothesis["status"],
    createdAt: row.createdAt,
  };
}

export function mapResearchExperiment(row: {
  id: string;
  hypothesisId: string;
  datasetRole: string;
  datasetWindowStart: Date;
  datasetWindowEnd: Date;
  backtestId: string | null;
  status: string;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): ResearchExperiment {
  return {
    id: row.id,
    hypothesisId: row.hypothesisId,
    datasetRole: row.datasetRole as ResearchExperiment["datasetRole"],
    datasetWindowStart: row.datasetWindowStart,
    datasetWindowEnd: row.datasetWindowEnd,
    backtestId: row.backtestId,
    status: row.status as ResearchExperiment["status"],
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
```

Confirm `Prisma` and `Decimal` are already imported at the top of `mappers.ts` (they are, per the existing file); add the `AgentExecution`/`ResearchExperiment`/`ResearchHypothesis` type import alongside the existing `@trading-copilot/trading-domain` import line.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test -- mappers`
Expected: PASS

- [ ] **Step 9: Regenerate the Prisma client and typecheck**

Run: `pnpm --filter @trading-copilot/database exec prisma generate && pnpm --filter @trading-copilot/database typecheck && pnpm --filter @trading-copilot/trading-domain typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations packages/database/src/mappers.ts packages/database/src/mappers.test.ts packages/trading-domain/src/entities.ts packages/trading-domain/src/research-entities.ts packages/trading-domain/src/index.ts
git commit -m "feat(database): add ResearchHypothesis/ResearchExperiment/AgentExecution schema, PAPER_CANDIDATE status, final-test reuse index"
```

---

### Task 2: Shared contracts — research queue, enums, request DTOs

**Owner:** backend-engineer

**Files:**
- Create: `packages/shared-types/src/research.ts`
- Modify: `packages/shared-types/src/enums.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/research.test.ts`

**Interfaces:**
- Consumes: `TIMEFRAMES`, `Timeframe` (existing, from `packages/shared-types/src/enums.ts`).
- Produces: `RESEARCH_AGENT_QUEUE`, `RUN_RESEARCH_AGENT_JOB`, `RESEARCH_AGENT_JOB_OPTIONS`, `ResearchAgentJobPayload`. Value arrays + types: `AI_PROVIDER_TYPES`/`AIProviderType`, `AGENT_EXECUTION_STATUSES`/`AgentExecutionStatus`, `HYPOTHESIS_CONFIDENCE_LEVELS`/`HypothesisConfidence`, `RESEARCH_HYPOTHESIS_STATUSES`/`ResearchHypothesisStatus`, `RESEARCH_EXPERIMENT_STATUSES`/`ResearchExperimentStatus`, `RESEARCH_DATASET_ROLES`/`ResearchDatasetRole`. Zod schemas: `generateResearchHypothesisRequestSchema`/`GenerateResearchHypothesisRequestInput`, `createResearchExperimentRequestSchema`/`CreateResearchExperimentRequestInput`, `markPaperCandidateRequestSchema`/`MarkPaperCandidateRequestInput`.

- [ ] **Step 1: Write the failing schema test**

```typescript
// packages/shared-types/src/research.test.ts
import { describe, expect, it } from "vitest";
import { createResearchExperimentRequestSchema, generateResearchHypothesisRequestSchema } from "./research";

describe("generateResearchHypothesisRequestSchema", () => {
  it("accepts an empty body (research scope defaults to all data)", () => {
    expect(generateResearchHypothesisRequestSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys", () => {
    expect(() => generateResearchHypothesisRequestSchema.parse({ strategyId: "s1", bogus: true })).toThrow();
  });
});

describe("createResearchExperimentRequestSchema", () => {
  it("parses a valid RESEARCH-stage request", () => {
    const input = {
      datasetRole: "RESEARCH",
      datasetWindowStart: "2026-01-01T00:00:00.000Z",
      datasetWindowEnd: "2026-04-01T00:00:00.000Z",
      instrumentId: "11111111-1111-1111-1111-111111111111",
      timeframe: "5m",
      initialBalance: "10000",
      riskPercentage: "1",
      slippageTicks: 1,
    };
    expect(createResearchExperimentRequestSchema.parse(input)).toEqual(input);
  });

  it("rejects an invalid datasetRole", () => {
    expect(() =>
      createResearchExperimentRequestSchema.parse({
        datasetRole: "BOGUS",
        datasetWindowStart: "2026-01-01T00:00:00.000Z",
        datasetWindowEnd: "2026-04-01T00:00:00.000Z",
        instrumentId: "11111111-1111-1111-1111-111111111111",
        timeframe: "5m",
        initialBalance: "10000",
        riskPercentage: "1",
        slippageTicks: 1,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/shared-types test -- research`
Expected: FAIL — `./research` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/shared-types/src/research.ts
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
```

Modify `packages/shared-types/src/enums.ts`'s `STRATEGY_VERSION_STATUSES` array to insert `"PAPER_CANDIDATE"` between `"WALK_FORWARD"` and `"PAPER_TRADING"`, matching the Prisma enum from Task 1 exactly.

Modify `packages/shared-types/src/index.ts` to add `export * from "./research";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/shared-types test -- research`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @trading-copilot/shared-types typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared-types/src/research.ts packages/shared-types/src/research.test.ts packages/shared-types/src/enums.ts packages/shared-types/src/index.ts
git commit -m "feat(shared-types): add research-agent queue constants, dataset-role/status enums, request schemas"
```

---

### Task 3: StrategyDefinition DSL + deterministic interpreter, registry generalization, backtester generic widening

**Owner:** quant-engineer

**Files:**
- Create: `packages/strategy-engine/src/types.ts`
- Create: `packages/strategy-engine/src/strategies/strategy-definition.ts`
- Create: `packages/strategy-engine/src/registry.ts`
- Modify: `packages/strategy-engine/src/strategies/ema-trend-pullback.ts`
- Modify: `packages/strategy-engine/src/index.ts`
- Modify: `packages/backtester/src/engine.ts`
- Test: `packages/strategy-engine/src/strategies/strategy-definition.test.ts`
- Test: `packages/backtester/src/engine.test.ts` (existing file — add a DSL-backed backtest case)

**Interfaces:**
- Consumes: `calculateEma`, `calculateAtr` (existing, `packages/strategy-engine/src/indicators/`).
- Produces: `StrategySignal` (moved, same shape as before). `strategyDefinitionSchema`/`StrategyDefinition` (Zod, `.strict()`). `evaluateStrategyDefinition(candles, definition): StrategySignal[]`. `STRATEGY_REGISTRY` (now includes `"ema-trend-pullback"` and `"ai-generated-dsl-v1"` keys), `StrategyKey`, `StrategyParametersFor<K>` — all still importable from `@trading-copilot/strategy-engine` at the same paths as before (index.ts re-exports unchanged for existing callers). `BacktestRunInput<K extends StrategyKey>` (generic, was previously hardcoded to `EmaTrendPullbackParameters`).

- [ ] **Step 1: Move `StrategySignal` to a shared file**

```typescript
// packages/strategy-engine/src/types.ts
import Decimal from "decimal.js";
import type { Direction } from "@trading-copilot/shared-types";

/**
 * Shared by every strategy implementation registered in STRATEGY_REGISTRY —
 * moved out of ema-trend-pullback.ts once a second strategy
 * (strategy-definition.ts) needed the same shape.
 */
export interface StrategySignal {
  index: number;
  timestamp: Date;
  direction: Direction;
  closeAtSignal: Decimal;
  atrAtSignal: Decimal;
  entryReason: string;
}
```

In `packages/strategy-engine/src/strategies/ema-trend-pullback.ts`: delete the `StrategySignal` interface (lines 47-54) and the `STRATEGY_REGISTRY`/`StrategyKey` export block (the final `export const STRATEGY_REGISTRY = {...}` and `export type StrategyKey = ...`); add `import type { StrategySignal } from "../types";` at the top. Everything else in the file (schema, defaults, `evaluateEmaTrendPullback`) is unchanged.

- [ ] **Step 2: Write the failing DSL test**

```typescript
// packages/strategy-engine/src/strategies/strategy-definition.test.ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { Candle } from "@trading-copilot/trading-domain";
import { evaluateStrategyDefinition, strategyDefinitionSchema } from "./strategy-definition";

function candle(timestamp: string, open: number, high: number, low: number, close: number): Candle {
  return {
    timestamp: new Date(timestamp),
    open: new Decimal(open),
    high: new Decimal(high),
    low: new Decimal(low),
    close: new Decimal(close),
    volume: new Decimal(100),
  };
}

const DEFINITION = strategyDefinitionSchema.parse({
  version: "1.0.0",
  direction: "LONG",
  entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 2, slowPeriod: 3 }],
  atrPeriod: 2,
  stopAtrMultiplier: 1,
  targetAtrMultiplier: 2,
});

describe("evaluateStrategyDefinition", () => {
  it("rejects an unknown rule type at parse time", () => {
    expect(() =>
      strategyDefinitionSchema.parse({
        version: "1.0.0",
        direction: "LONG",
        entryRules: [{ type: "DELETE_ALL_TRADES" }],
        atrPeriod: 2,
        stopAtrMultiplier: 1,
        targetAtrMultiplier: 2,
      }),
    ).toThrow();
  });

  it("is look-ahead-safe: only reads candles[0..i] when deciding about index i", () => {
    const candles = [
      candle("2026-01-01T00:00:00Z", 10, 10, 10, 10),
      candle("2026-01-01T00:01:00Z", 10, 10, 10, 10),
      candle("2026-01-01T00:02:00Z", 10, 10, 10, 12),
      candle("2026-01-01T00:03:00Z", 12, 12, 12, 12),
      candle("2026-01-01T00:04:00Z", 12, 12, 12, 12),
    ];
    const fullSignals = evaluateStrategyDefinition(candles, DEFINITION);
    const prefixSignals = evaluateStrategyDefinition(candles.slice(0, 4), DEFINITION);
    const fullSignalsUpToIndex3 = fullSignals.filter((s) => s.index <= 3);
    expect(prefixSignals).toEqual(fullSignalsUpToIndex3);
  });

  it("produces a LONG signal on a fast-over-slow EMA cross with atrAtSignal populated", () => {
    const candles = [
      candle("2026-01-01T00:00:00Z", 10, 10, 10, 10),
      candle("2026-01-01T00:01:00Z", 10, 10, 10, 9),
      candle("2026-01-01T00:02:00Z", 9, 9, 9, 8),
      candle("2026-01-01T00:03:00Z", 8, 8, 8, 13),
      candle("2026-01-01T00:04:00Z", 13, 13, 13, 13),
    ];
    const signals = evaluateStrategyDefinition(candles, DEFINITION);
    expect(signals.length).toBeGreaterThan(0);
    const signal = signals[0]!;
    expect(signal.direction).toBe("LONG");
    expect(signal.atrAtSignal.greaterThan(0)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/strategy-engine test -- strategy-definition`
Expected: FAIL — `./strategy-definition` does not exist.

- [ ] **Step 4: Implement the DSL schema and interpreter**

```typescript
// packages/strategy-engine/src/strategies/strategy-definition.ts
import Decimal from "decimal.js";
import { z } from "zod";
import type { Candle } from "@trading-copilot/trading-domain";
import { calculateAtr } from "../indicators/atr";
import { calculateEma } from "../indicators/ema";
import type { StrategySignal } from "../types";

/**
 * The safe, schema-validated rule grammar an AI-proposed StrategyDefinition
 * must use — no arbitrary code, no dynamic TypeScript generation (that
 * would reintroduce the exact code-injection risk this DSL exists to
 * prevent). Generalizes ema-trend-pullback.ts's fast/slow-EMA-cross shape
 * into a declarative rule a human or the ResearchAgent can compose from a
 * small closed set of conditions. Every rule references only indicators
 * this package already computes deterministically.
 */
const emaCrossAboveRuleSchema = z
  .object({
    type: z.literal("EMA_CROSS_ABOVE"),
    fastPeriod: z.number().int().positive(),
    slowPeriod: z.number().int().positive(),
  })
  .strict();

const emaCrossBelowRuleSchema = z
  .object({
    type: z.literal("EMA_CROSS_BELOW"),
    fastPeriod: z.number().int().positive(),
    slowPeriod: z.number().int().positive(),
  })
  .strict();

const closeAboveEmaRuleSchema = z
  .object({
    type: z.literal("CLOSE_ABOVE_EMA"),
    period: z.number().int().positive(),
  })
  .strict();

const closeBelowEmaRuleSchema = z
  .object({
    type: z.literal("CLOSE_BELOW_EMA"),
    period: z.number().int().positive(),
  })
  .strict();

const entryRuleSchema = z.discriminatedUnion("type", [
  emaCrossAboveRuleSchema,
  emaCrossBelowRuleSchema,
  closeAboveEmaRuleSchema,
  closeBelowEmaRuleSchema,
]);

export type EntryRule = z.infer<typeof entryRuleSchema>;

/**
 * "parameters" for the "ai-generated-dsl-v1" STRATEGY_REGISTRY key IS this
 * whole document (not a separate parameters object) — the DSL document is
 * itself what a StrategyVersion.parameters column stores for that key. All
 * entryRules must agree (ANDed together) for a signal to fire on a given
 * candle; direction fixes which side the strategy trades (a hypothesis
 * that wants both sides proposes two separate StrategyDefinitions).
 */
export const strategyDefinitionSchema = z
  .object({
    version: z.literal("1.0.0"),
    direction: z.enum(["LONG", "SHORT"]),
    entryRules: z.array(entryRuleSchema).min(1),
    atrPeriod: z.number().int().positive(),
    stopAtrMultiplier: z.number().positive(),
    targetAtrMultiplier: z.number().positive(),
  })
  .strict();

export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;

interface RuleEvaluationContext {
  index: number;
  closes: Decimal[];
  emaCache: Map<number, Array<Decimal | null>>;
}

function getEma(ctx: RuleEvaluationContext, period: number): Array<Decimal | null> {
  let cached = ctx.emaCache.get(period);
  if (!cached) {
    cached = calculateEma(ctx.closes, period);
    ctx.emaCache.set(period, cached);
  }
  return cached;
}

function evaluateRule(rule: EntryRule, ctx: RuleEvaluationContext): boolean {
  const { index } = ctx;
  if (index < 1) {
    return false;
  }

  switch (rule.type) {
    case "EMA_CROSS_ABOVE": {
      const fast = getEma(ctx, rule.fastPeriod);
      const slow = getEma(ctx, rule.slowPeriod);
      const fastNow = fast[index];
      const fastPrev = fast[index - 1];
      const slowNow = slow[index];
      const slowPrev = slow[index - 1];
      if (fastNow == null || fastPrev == null || slowNow == null || slowPrev == null) {
        return false;
      }
      return fastPrev.lessThanOrEqualTo(slowPrev) && fastNow.greaterThan(slowNow);
    }
    case "EMA_CROSS_BELOW": {
      const fast = getEma(ctx, rule.fastPeriod);
      const slow = getEma(ctx, rule.slowPeriod);
      const fastNow = fast[index];
      const fastPrev = fast[index - 1];
      const slowNow = slow[index];
      const slowPrev = slow[index - 1];
      if (fastNow == null || fastPrev == null || slowNow == null || slowPrev == null) {
        return false;
      }
      return fastPrev.greaterThanOrEqualTo(slowPrev) && fastNow.lessThan(slowNow);
    }
    case "CLOSE_ABOVE_EMA": {
      const ema = getEma(ctx, rule.period);
      const emaNow = ema[index];
      if (emaNow == null) {
        return false;
      }
      return ctx.closes[index]!.greaterThan(emaNow);
    }
    case "CLOSE_BELOW_EMA": {
      const ema = getEma(ctx, rule.period);
      const emaNow = ema[index];
      if (emaNow == null) {
        return false;
      }
      return ctx.closes[index]!.lessThan(emaNow);
    }
  }
}

/**
 * Look-ahead-safe by construction, identical discipline to
 * evaluateEmaTrendPullback: deciding about index i only ever reads
 * candles[0..i] (calculateEma/calculateAtr are computed once over the
 * whole series, but index i of those arrays only depends on values[0..i]).
 * All of a definition's entryRules must be true (ANDed) for a signal.
 */
export function evaluateStrategyDefinition(
  candles: Candle[],
  definition: StrategyDefinition,
): StrategySignal[] {
  const parsed = strategyDefinitionSchema.parse(definition);
  const closes = candles.map((candle) => candle.close);
  const atr = calculateAtr(candles, parsed.atrPeriod);
  const ctx: RuleEvaluationContext = { index: 0, closes, emaCache: new Map() };

  const signals: StrategySignal[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    ctx.index = i;
    const atrNow = atr[i];
    if (atrNow == null) {
      continue;
    }

    const allRulesPass = parsed.entryRules.every((rule) => evaluateRule(rule, ctx));
    if (!allRulesPass) {
      continue;
    }

    const candle = candles[i] as Candle;
    signals.push({
      index: i,
      timestamp: candle.timestamp,
      direction: parsed.direction,
      closeAtSignal: closes[i] as Decimal,
      atrAtSignal: atrNow,
      entryReason: `StrategyDefinition v${parsed.version}: ${parsed.entryRules.map((r) => r.type).join(" AND ")}`,
    });
  }

  return signals;
}
```

- [ ] **Step 5: Create the merged registry**

```typescript
// packages/strategy-engine/src/registry.ts
import {
  emaTrendPullbackParametersSchema,
  evaluateEmaTrendPullback,
} from "./strategies/ema-trend-pullback";
import { evaluateStrategyDefinition, strategyDefinitionSchema } from "./strategies/strategy-definition";

/**
 * Registry of every strategy implementation keyed by Strategy.key, so
 * callers (the backtester, the API) can look up an evaluator + parameter
 * schema without hardcoding a switch statement. "ai-generated-dsl-v1" is
 * the single generic interpreter every AI-proposed hypothesis's
 * StrategyDefinition runs through — the ResearchAgent never generates or
 * registers new TypeScript code at runtime (see docs/ai-research.md
 * "Why a DSL, not generated code").
 */
export const STRATEGY_REGISTRY = {
  "ema-trend-pullback": {
    parametersSchema: emaTrendPullbackParametersSchema,
    evaluate: evaluateEmaTrendPullback,
  },
  "ai-generated-dsl-v1": {
    parametersSchema: strategyDefinitionSchema,
    evaluate: evaluateStrategyDefinition,
  },
} as const;

export type StrategyKey = keyof typeof STRATEGY_REGISTRY;
```

Modify `packages/strategy-engine/src/index.ts`:

```typescript
export * from "./indicators/ema";
export * from "./indicators/atr";
export * from "./types";
export * from "./strategies/ema-trend-pullback";
export * from "./strategies/strategy-definition";
export * from "./registry";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/strategy-engine test`
Expected: PASS (existing `ema-trend-pullback` tests unaffected; new `strategy-definition` tests pass)

- [ ] **Step 7: Widen `BacktestRunInput` to be generic over `StrategyKey`**

In `packages/backtester/src/engine.ts`, replace the import line and `BacktestRunInput` interface:

```typescript
import {
  STRATEGY_REGISTRY,
  type StrategyKey,
  type StrategySignal,
} from "@trading-copilot/strategy-engine";

/**
 * The subset of a strategy's parameters every backtest actually needs at
 * the engine level. Every STRATEGY_REGISTRY entry's parameters structurally
 * include these two fields (see docs/backtesting-assumptions.md "Stop and
 * target derivation" — ATR-derived stops/targets are a system-wide backtest
 * assumption, not a per-strategy choice), so this narrowing is always safe;
 * see the single documented cast in runBacktest below.
 */
export interface AtrStopTargetParameters {
  stopAtrMultiplier: number;
  targetAtrMultiplier: number;
}

export type StrategyParametersFor<K extends StrategyKey> = Parameters<
  (typeof STRATEGY_REGISTRY)[K]["evaluate"]
>[1];

export interface BacktestRunInput<K extends StrategyKey = StrategyKey> {
  /**
   * Which strategy implementation to resolve out of STRATEGY_REGISTRY. This
   * package has no database dependency, so it cannot look up
   * `strategyVersion.strategyId -> Strategy.key` itself — the caller (the
   * worker, which does have DB access) resolves the key and passes it here
   * explicitly, alongside the already-validated strategyVersion.
   */
  strategyKey: K;
  instrument: Instrument;
  /**
   * Single timeframe, single instrument, MUST be strictly increasing by
   * timestamp. runBacktest throws BacktesterError on duplicate or
   * out-of-order candles rather than silently producing wrong results.
   */
  candles: Candle[];
  strategyVersion: StrategyVersion<StrategyParametersFor<K>>;
  initialBalance: Decimal;
  riskPercentage: Decimal;
  /** Adverse slippage in ticks, applied on both entry and exit fills. */
  slippageTicks: number;
}
```

Change `runBacktest`'s signature to `export function runBacktest<K extends StrategyKey>(input: BacktestRunInput<K>): BacktestRunResult {` and, inside it, the one call site that needs the narrowed type:

```typescript
    const plan = planEntry(
      signal,
      entryIndex,
      candles,
      slippageAmount,
      // Safe per AtrStopTargetParameters' doc comment: every registered
      // strategy's parameters structurally include stopAtrMultiplier/
      // targetAtrMultiplier.
      strategyVersion.parameters as AtrStopTargetParameters,
    );
```

Change `planEntry`'s and `walkTradeForward`'s signatures from `parameters: EmaTrendPullbackParameters` / `strategyVersion: StrategyVersion<EmaTrendPullbackParameters>` to `parameters: AtrStopTargetParameters` / `strategyVersion: Pick<StrategyVersion<unknown>, "id">` respectively (the function only ever reads `strategyVersion.id`). Remove the now-unused `EmaTrendPullbackParameters` import.

- [ ] **Step 8: Add a DSL-backed backtest regression test**

```typescript
// packages/backtester/src/engine.test.ts — add to the existing file, reusing its existing candle()/instrument() test helpers
import { strategyDefinitionSchema } from "@trading-copilot/strategy-engine";

it("runs an AI-generated-DSL strategy through the same engine as ema-trend-pullback, unchanged", () => {
  const definition = strategyDefinitionSchema.parse({
    version: "1.0.0",
    direction: "LONG",
    entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 2, slowPeriod: 3 }],
    atrPeriod: 2,
    stopAtrMultiplier: 1,
    targetAtrMultiplier: 2,
  });

  const result = runBacktest({
    strategyKey: "ai-generated-dsl-v1",
    instrument: testInstrument(),
    candles: testTrendingCandles(),
    strategyVersion: {
      id: "sv-dsl-1",
      strategyId: "s-dsl",
      version: "1.0.0",
      name: "DSL test",
      description: "test",
      parameters: definition,
      status: "DISCOVERED",
      createdAt: new Date(),
    },
    initialBalance: new Decimal(10000),
    riskPercentage: new Decimal(1),
    slippageTicks: 1,
  });

  expect(Array.isArray(result.trades)).toBe(true);
});
```

(Use the existing file's own `testInstrument()`/`testTrendingCandles()` helper names — check the existing test file's top-level helpers and reuse them exactly; do not redefine duplicates.)

- [ ] **Step 9: Run all backtester and strategy-engine tests, and typecheck**

Run: `pnpm --filter @trading-copilot/backtester test && pnpm --filter @trading-copilot/backtester typecheck && pnpm --filter @trading-copilot/strategy-engine typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/strategy-engine packages/backtester/src/engine.ts packages/backtester/src/engine.test.ts
git commit -m "feat(strategy-engine): add StrategyDefinition DSL + deterministic interpreter; widen backtester to any registered strategy key"
```

---

### Task 4: Analytics — research data summary, sample-size guardrails, parameter sensitivity, walk-forward windows

**Owner:** quant-engineer

**Files:**
- Create: `packages/analytics/src/research-summary.ts`
- Create: `packages/analytics/src/parameter-sensitivity.ts`
- Create: `packages/analytics/src/walk-forward.ts`
- Modify: `packages/analytics/src/index.ts`
- Test: `packages/analytics/src/research-summary.test.ts`
- Test: `packages/analytics/src/parameter-sensitivity.test.ts`
- Test: `packages/analytics/src/walk-forward.test.ts`

**Interfaces:**
- Consumes: `calculateTradeAnalytics`, `TradeAnalyticsMetrics` (`./metrics`); `averageNonNull`, `isWinner`, `isLoser`, `computeProfitFactor` (`./utils`, internal, same-package import); `NormalizedTrade` (`@trading-copilot/trading-domain`).
- Produces: `EnrichedJournalTradeContext`, `EnrichedJournalTrade`, `CategoricalBreakdown`, `ContinuousVariableComparison`, `ResearchDataSummary`, `buildResearchDataSummary(trades): ResearchDataSummary`, `MINIMUM_CALENDAR_DAYS`, `MINIMUM_CANDIDATE_SETUPS`, `SampleSizeGuardrailResult`, `assertSampleSizeGuardrails(summary): SampleSizeGuardrailResult`, `ParameterVariation`, `ParameterSensitivityReport`, `compareParameterVariations(baseline, variations): ParameterSensitivityReport`, `WalkForwardWindow`, `generateWalkForwardWindows(totalStart, totalEnd, windowLengthDays, stepDays): WalkForwardWindow[]`.

- [ ] **Step 1: Write the failing research-summary test**

```typescript
// packages/analytics/src/research-summary.test.ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { assertSampleSizeGuardrails, buildResearchDataSummary, type EnrichedJournalTrade } from "./research-summary";

function trade(overrides: Partial<EnrichedJournalTrade>): EnrichedJournalTrade {
  return {
    source: "JOURNAL",
    id: "t1",
    strategyId: "s1",
    strategyVersionId: "sv1",
    instrumentId: "i1",
    direction: "LONG",
    executionMode: "MANUAL_LIVE",
    entryTimestamp: new Date("2026-01-01T00:00:00Z"),
    exitTimestamp: new Date("2026-01-01T01:00:00Z"),
    entryPrice: new Decimal(100),
    exitPrice: new Decimal(101),
    quantity: 1,
    grossPnl: new Decimal(100),
    fees: new Decimal(4),
    netPnl: new Decimal(96),
    riskAmount: new Decimal(50),
    rMultiple: new Decimal(1.92),
    mfe: new Decimal(2),
    mae: new Decimal(0.5),
    slippage: null,
    context: { session: "LONDON", timeOfDay: "MORNING", marketRegime: "TRENDING", vwapDistance: new Decimal(1.2), volumePercentile: new Decimal(60), atrPercentile: new Decimal(40) },
    ...overrides,
  } as EnrichedJournalTrade;
}

describe("buildResearchDataSummary", () => {
  it("buckets by session/timeOfDay/marketRegime and reports continuous-variable comparisons", () => {
    const winner = trade({ id: "w1", netPnl: new Decimal(100) });
    const loser = trade({
      id: "l1",
      netPnl: new Decimal(-50),
      context: { session: "NEW_YORK", timeOfDay: "AFTERNOON", marketRegime: "RANGING", vwapDistance: new Decimal(3.5), volumePercentile: new Decimal(90), atrPercentile: new Decimal(80) },
    });

    const summary = buildResearchDataSummary([winner, loser]);

    expect(summary.overall.tradeCount).toBe(2);
    expect(summary.bySession.map((b) => b.value).sort()).toEqual(["LONDON", "NEW_YORK"]);
    expect(summary.vwapDistance.averageAmongWinners?.toString()).toBe("1.2");
    expect(summary.vwapDistance.averageAmongLosers?.toString()).toBe("3.5");
  });

  it("buckets a null context field under UNKNOWN rather than dropping the trade", () => {
    const summary = buildResearchDataSummary([trade({ context: null })]);
    expect(summary.bySession).toEqual([expect.objectContaining({ value: "UNKNOWN", sampleSize: 1 })]);
  });
});

describe("assertSampleSizeGuardrails", () => {
  it("fails when both calendar days and setup count are below the minimum", () => {
    const result = assertSampleSizeGuardrails({
      sampleWindowStart: new Date("2026-01-01T00:00:00Z"),
      sampleWindowEnd: new Date("2026-01-10T00:00:00Z"),
      overall: { tradeCount: 5 },
    });
    expect(result.passes).toBe(false);
    expect(result.reasons.length).toBe(2);
  });

  it("passes when both guardrails are satisfied", () => {
    const result = assertSampleSizeGuardrails({
      sampleWindowStart: new Date("2026-01-01T00:00:00Z"),
      sampleWindowEnd: new Date("2026-04-01T00:00:00Z"),
      overall: { tradeCount: 120 },
    });
    expect(result.passes).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/analytics test -- research-summary`
Expected: FAIL — `./research-summary` does not exist.

- [ ] **Step 3: Implement `research-summary.ts`**

```typescript
// packages/analytics/src/research-summary.ts
import Decimal from "decimal.js";
import type { NormalizedTrade } from "@trading-copilot/trading-domain";
import { calculateTradeAnalytics, type TradeAnalyticsMetrics } from "./metrics";
import { averageNonNull, isLoser, isWinner } from "./utils";

/**
 * Only populated for a JOURNAL-sourced trade whose JournalTrade had a
 * setupId (a MarketSnapshot-backed Setup) — a purely manual journal entry,
 * or any BACKTEST-sourced trade (backtests are not tied to a Setup), has
 * `context: null`. This is a real limitation, not an oversight: see
 * docs/ai-research.md "What the ResearchAgent can and cannot see".
 */
export interface EnrichedJournalTradeContext {
  session: string | null;
  timeOfDay: string | null;
  marketRegime: string | null;
  vwapDistance: Decimal | null;
  volumePercentile: Decimal | null;
  atrPercentile: Decimal | null;
}

export interface EnrichedJournalTrade extends NormalizedTrade {
  context: EnrichedJournalTradeContext | null;
}

export interface CategoricalBreakdown {
  value: string;
  sampleSize: number;
  winRate: Decimal;
  averageR: Decimal;
  profitFactor: Decimal | null;
}

export interface ContinuousVariableComparison {
  averageAmongWinners: Decimal | null;
  averageAmongLosers: Decimal | null;
  averageAmongAll: Decimal | null;
}

export interface ResearchDataSummary {
  overall: TradeAnalyticsMetrics;
  sampleWindowStart: Date | null;
  sampleWindowEnd: Date | null;
  bySession: CategoricalBreakdown[];
  byTimeOfDay: CategoricalBreakdown[];
  byMarketRegime: CategoricalBreakdown[];
  byDirection: CategoricalBreakdown[];
  vwapDistance: ContinuousVariableComparison;
  volumePercentile: ContinuousVariableComparison;
  atrPercentile: ContinuousVariableComparison;
}

const UNKNOWN = "UNKNOWN";

function breakdownByKey(
  trades: EnrichedJournalTrade[],
  keyOf: (trade: EnrichedJournalTrade) => string | null,
): CategoricalBreakdown[] {
  const buckets = new Map<string, EnrichedJournalTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade) ?? UNKNOWN;
    const bucket = buckets.get(key) ?? [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries()).map(([value, bucketTrades]) => {
    const metrics = calculateTradeAnalytics(bucketTrades);
    return {
      value,
      sampleSize: bucketTrades.length,
      winRate: metrics.winRate,
      averageR: metrics.averageR,
      profitFactor: metrics.profitFactor,
    };
  });
}

function continuousComparison(
  trades: EnrichedJournalTrade[],
  valueOf: (trade: EnrichedJournalTrade) => Decimal | null,
): ContinuousVariableComparison {
  const winners = trades.filter((t) => isWinner(t.netPnl));
  const losers = trades.filter((t) => isLoser(t.netPnl));
  return {
    averageAmongWinners: averageNonNull(winners.map(valueOf)),
    averageAmongLosers: averageNonNull(losers.map(valueOf)),
    averageAmongAll: averageNonNull(trades.map(valueOf)),
  };
}

/**
 * The deterministic, non-AI statistics layer the ResearchAgent consumes —
 * per docs/research-methodology.md "AI interprets these statistics. It
 * does NOT calculate." Callers pass already-filtered/chronologically
 * ordered trades (see repositories/research.ts'
 * listEnrichedJournalTradesForResearch).
 */
export function buildResearchDataSummary(trades: EnrichedJournalTrade[]): ResearchDataSummary {
  const overall = calculateTradeAnalytics(trades);
  const timestamps = trades.map((t) => t.entryTimestamp.getTime());

  return {
    overall,
    sampleWindowStart: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null,
    sampleWindowEnd: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null,
    bySession: breakdownByKey(trades, (t) => t.context?.session ?? null),
    byTimeOfDay: breakdownByKey(trades, (t) => t.context?.timeOfDay ?? null),
    byMarketRegime: breakdownByKey(trades, (t) => t.context?.marketRegime ?? null),
    byDirection: breakdownByKey(trades, (t) => t.direction),
    vwapDistance: continuousComparison(trades, (t) => t.context?.vwapDistance ?? null),
    volumePercentile: continuousComparison(trades, (t) => t.context?.volumePercentile ?? null),
    atrPercentile: continuousComparison(trades, (t) => t.context?.atrPercentile ?? null),
  };
}

/** Example starting guardrails per docs/research-methodology.md — configurable, not mathematical guarantees. */
export const MINIMUM_CALENDAR_DAYS = 60;
export const MINIMUM_CANDIDATE_SETUPS = 100;

export interface SampleSizeGuardrailResult {
  passes: boolean;
  calendarDays: number;
  setupCount: number;
  reasons: string[];
}

/**
 * Gates VALIDATION/FINAL_TEST/WALK_FORWARD experiment creation and the
 * PAPER_CANDIDATE transition — see apps/api/src/research/research.service.ts.
 * Both conditions are required, never either alone (see
 * docs/research-methodology.md "Sample size guardrails").
 */
export function assertSampleSizeGuardrails(summary: {
  sampleWindowStart: Date | null;
  sampleWindowEnd: Date | null;
  overall: { tradeCount: number };
}): SampleSizeGuardrailResult {
  const calendarDays =
    summary.sampleWindowStart && summary.sampleWindowEnd
      ? Math.floor(
          (summary.sampleWindowEnd.getTime() - summary.sampleWindowStart.getTime()) / (1000 * 60 * 60 * 24),
        )
      : 0;
  const setupCount = summary.overall.tradeCount;

  const reasons: string[] = [];
  if (calendarDays < MINIMUM_CALENDAR_DAYS) {
    reasons.push(`only ${calendarDays} calendar days of data (minimum ${MINIMUM_CALENDAR_DAYS})`);
  }
  if (setupCount < MINIMUM_CANDIDATE_SETUPS) {
    reasons.push(`only ${setupCount} candidate setups (minimum ${MINIMUM_CANDIDATE_SETUPS})`);
  }

  return { passes: reasons.length === 0, calendarDays, setupCount, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trading-copilot/analytics test -- research-summary`
Expected: PASS

- [ ] **Step 5: Write the failing parameter-sensitivity and walk-forward tests**

```typescript
// packages/analytics/src/parameter-sensitivity.test.ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { compareParameterVariations, type ParameterVariation } from "./parameter-sensitivity";
import type { TradeAnalyticsMetrics } from "./metrics";

function metricsWithExpectancy(expectancy: number): TradeAnalyticsMetrics {
  return {
    tradeCount: 10,
    wins: 5,
    losses: 5,
    winRate: new Decimal(0.5),
    grossProfit: new Decimal(0),
    grossLoss: new Decimal(0),
    netPnl: new Decimal(0),
    averagePnl: new Decimal(0),
    expectancy: new Decimal(expectancy),
    averageR: new Decimal(0),
    profitFactor: null,
    averageWinner: new Decimal(0),
    averageLoser: new Decimal(0),
    largestWinner: new Decimal(0),
    largestLoser: new Decimal(0),
    maxDrawdown: new Decimal(0),
    maxDrawdownPercent: null,
    maximumConsecutiveWins: 0,
    maximumConsecutiveLosses: 0,
    mfeAverage: null,
    maeAverage: null,
    totalFees: new Decimal(0),
    averageSlippage: null,
  };
}

function variation(label: string, expectancy: number): ParameterVariation {
  return { label, parameters: { stopAtrMultiplier: 1 }, metrics: metricsWithExpectancy(expectancy) };
}

describe("compareParameterVariations", () => {
  it("warns when more than half the variations perform at less than 50% of the best expectancy", () => {
    const report = compareParameterVariations(variation("baseline", 100), [
      variation("v1", 10),
      variation("v2", 5),
      variation("v3", 90),
    ]);
    expect(report.isolatedPeakWarning).not.toBeNull();
  });

  it("returns no warning when variations form a stable region", () => {
    const report = compareParameterVariations(variation("baseline", 100), [
      variation("v1", 95),
      variation("v2", 90),
      variation("v3", 92),
    ]);
    expect(report.isolatedPeakWarning).toBeNull();
  });
});
```

```typescript
// packages/analytics/src/walk-forward.test.ts
import { describe, expect, it } from "vitest";
import { generateWalkForwardWindows } from "./walk-forward";

describe("generateWalkForwardWindows", () => {
  it("generates non-overlapping-start, deterministic windows stepping forward by stepDays", () => {
    const windows = generateWalkForwardWindows(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z") < new Date("2026-03-01T00:00:00Z") ? 30 : 30,
      15,
    );
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]).toEqual({
      index: 0,
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-31T00:00:00Z"),
    });
    expect(windows[1]!.start).toEqual(new Date("2026-01-16T00:00:00Z"));
  });

  it("rejects non-positive window/step lengths", () => {
    expect(() => generateWalkForwardWindows(new Date(), new Date(Date.now() + 1000), 0, 1)).toThrow();
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm --filter @trading-copilot/analytics test -- parameter-sensitivity walk-forward`
Expected: FAIL — files do not exist.

- [ ] **Step 7: Implement `parameter-sensitivity.ts` and `walk-forward.ts`**

```typescript
// packages/analytics/src/parameter-sensitivity.ts
import type { TradeAnalyticsMetrics } from "./metrics";

/**
 * Foundation only — compares already-computed metrics from backtests the
 * caller ran; this module never runs a backtest itself. Per
 * docs/research-methodology.md "Overfitting and parameter mining": prefer
 * stable, wide parameter regions over isolated performance peaks.
 */
export interface ParameterVariation {
  label: string;
  parameters: Record<string, unknown>;
  metrics: TradeAnalyticsMetrics;
}

export interface ParameterSensitivityReport {
  baseline: ParameterVariation;
  variations: ParameterVariation[];
  isolatedPeakWarning: string | null;
}

export function compareParameterVariations(
  baseline: ParameterVariation,
  variations: ParameterVariation[],
): ParameterSensitivityReport {
  if (variations.length === 0) {
    return { baseline, variations: [], isolatedPeakWarning: null };
  }

  const all = [baseline, ...variations];
  const expectancies = all.map((v) => v.metrics.expectancy);
  const maxExpectancy = expectancies.reduce((max, e) => (e.greaterThan(max) ? e : max), expectancies[0]!);
  const halfOfMax = maxExpectancy.times(0.5);
  const belowHalfCount = expectancies.filter((e) => e.lessThan(halfOfMax)).length;

  const isolatedPeakWarning =
    belowHalfCount / all.length > 0.5
      ? "More than half of the tested parameter variations perform at less than 50% of the " +
        "best variation's expectancy — this may be an isolated performance peak rather than a " +
        "stable region. See docs/research-methodology.md 'Overfitting and parameter mining'."
      : null;

  return { baseline, variations, isolatedPeakWarning };
}
```

```typescript
// packages/analytics/src/walk-forward.ts
export interface WalkForwardWindow {
  index: number;
  start: Date;
  end: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Foundation only — generates the (start, end) windows a future
 * walk-forward runner would iterate; this module does not run backtests or
 * make any pass/fail judgment. Deterministic and pure: identical inputs
 * always produce identical windows.
 */
export function generateWalkForwardWindows(
  totalStart: Date,
  totalEnd: Date,
  windowLengthDays: number,
  stepDays: number,
): WalkForwardWindow[] {
  if (windowLengthDays <= 0 || stepDays <= 0) {
    throw new Error("generateWalkForwardWindows: windowLengthDays and stepDays must both be positive");
  }
  if (totalEnd.getTime() <= totalStart.getTime()) {
    throw new Error("generateWalkForwardWindows: totalEnd must be after totalStart");
  }

  const windows: WalkForwardWindow[] = [];
  let windowStartMs = totalStart.getTime();
  let index = 0;

  while (windowStartMs + windowLengthDays * MS_PER_DAY <= totalEnd.getTime()) {
    const windowEndMs = windowStartMs + windowLengthDays * MS_PER_DAY;
    windows.push({ index, start: new Date(windowStartMs), end: new Date(windowEndMs) });
    windowStartMs += stepDays * MS_PER_DAY;
    index += 1;
  }

  return windows;
}
```

Modify `packages/analytics/src/index.ts`:

```typescript
export * from "./metrics";
export * from "./grouping";
export * from "./winners-losers";
export * from "./research-summary";
export * from "./parameter-sensitivity";
export * from "./walk-forward";
```

- [ ] **Step 8: Run all analytics tests and typecheck**

Run: `pnpm --filter @trading-copilot/analytics test && pnpm --filter @trading-copilot/analytics typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/analytics
git commit -m "feat(analytics): add research data summary, sample-size guardrails, parameter sensitivity and walk-forward window foundations"
```

---

### Task 5: Errors and database repository — hypotheses, experiments, AgentExecution, enriched journal trades, budgets

**Owner:** data-engineer

**Files:**
- Modify: `packages/database/src/errors.ts`
- Create: `packages/database/src/repositories/research.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/research.integration.test.ts`

**Interfaces:**
- Consumes: `mapAgentExecution`, `mapResearchHypothesis`, `mapResearchExperiment`, `mapMarketSnapshot`, `mapJournalTrade` (`./mappers`, existing + Task 1); `EnrichedJournalTrade` type (`@trading-copilot/analytics`, Task 4 — `packages/database` may depend on `packages/analytics`, matching the existing dependency direction where `packages/database` already depends on `packages/trading-domain`).
- Produces: `FinalTestAlreadySpentError`, `ResearchStageOrderError`, `ResearchBudgetExceededError` (`./errors`). `researchRepository`: `createAgentExecution(input)`, `markAgentExecutionSucceeded(id, {outputRaw, outputParsed, tokensInput, tokensOutput, costUsd})`, `markAgentExecutionFailed(id, {outputRaw, errorMessage})`, `getAgentExecution(id)`, `listAgentExecutions()`, `createResearchHypothesis(input)`, `getResearchHypothesis(id)`, `listResearchHypotheses()`, `createResearchExperiment(input)` (throws `FinalTestAlreadySpentError`/`ResearchStageOrderError`), `markResearchExperimentCompleted(id, backtestId)`, `markResearchExperimentFailed(id, reason)`, `listResearchExperimentsForHypothesis(hypothesisId)`, `getTodayResearchSpend()`, `listEnrichedJournalTradesForResearch(filter)`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/database/src/research.integration.test.ts
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./client";
import { researchRepository } from "./repositories/research";
import { FinalTestAlreadySpentError } from "./errors";
import { seedTestInstrument, seedTestStrategy } from "./test-helpers"; // reuse this project's existing seeding helpers — confirm exact names in an existing *.integration.test.ts before writing

describe("researchRepository", () => {
  let instrumentId: string;
  let strategyId: string;

  beforeAll(async () => {
    instrumentId = (await seedTestInstrument()).id;
    strategyId = (await seedTestStrategy()).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an AgentExecution RUNNING, then marks it SUCCEEDED with outputs", async () => {
    const created = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: { tradeCount: 10 },
    });
    expect(created.status).toBe("RUNNING");

    const succeeded = await researchRepository.markAgentExecutionSucceeded(created.id, {
      outputRaw: '{"title":"x"}',
      outputParsed: { title: "x" },
      tokensInput: 100,
      tokensOutput: 200,
      costUsd: new Decimal("0.001"),
    });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(succeeded.outputParsed).toEqual({ title: "x" });
  });

  it("never allows a second non-FAILED FINAL_TEST experiment for the same hypothesis", async () => {
    const execution = await researchRepository.createAgentExecution({
      agentType: "RESEARCH",
      provider: "MOCK",
      model: "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: {},
    });
    await researchRepository.markAgentExecutionSucceeded(execution.id, {
      outputRaw: "{}",
      outputParsed: {},
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: new Decimal(0),
    });
    const hypothesis = await researchRepository.createResearchHypothesis({
      agentExecutionId: execution.id,
      title: "t",
      statement: "s",
      rationale: "r",
      confidence: "MEDIUM",
      sourceDataSummary: {},
      proposedStrategyDefinition: {},
    });

    await researchRepository.createResearchExperiment({
      hypothesisId: hypothesis.id,
      datasetRole: "RESEARCH",
      datasetWindowStart: new Date("2026-01-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-04-01T00:00:00Z"),
    });
    await researchRepository.createResearchExperiment({
      hypothesisId: hypothesis.id,
      datasetRole: "VALIDATION",
      datasetWindowStart: new Date("2026-04-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-05-01T00:00:00Z"),
    });
    await researchRepository.createResearchExperiment({
      hypothesisId: hypothesis.id,
      datasetRole: "FINAL_TEST",
      datasetWindowStart: new Date("2026-05-01T00:00:00Z"),
      datasetWindowEnd: new Date("2026-06-01T00:00:00Z"),
    });

    await expect(
      researchRepository.createResearchExperiment({
        hypothesisId: hypothesis.id,
        datasetRole: "FINAL_TEST",
        datasetWindowStart: new Date("2026-06-01T00:00:00Z"),
        datasetWindowEnd: new Date("2026-07-01T00:00:00Z"),
      }),
    ).rejects.toThrow(FinalTestAlreadySpentError);
  });

  it("never physically deletes a FAILED experiment or AgentExecution — no delete function exists on the repository", () => {
    expect((researchRepository as Record<string, unknown>).deleteResearchExperiment).toBeUndefined();
    expect((researchRepository as Record<string, unknown>).deleteAgentExecution).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/database test -- research.integration`
Expected: FAIL — `./repositories/research` does not exist. Before writing the implementation, inspect an existing `*.integration.test.ts` file (e.g. `packages/database/src/journal.integration.test.ts`) to confirm the exact names of this project's test-seeding helpers and the `prisma`/`client` import path, and use those exact names instead of the illustrative `seedTestInstrument`/`seedTestStrategy` names above.

- [ ] **Step 3: Add the new error classes**

```typescript
// packages/database/src/errors.ts — add
export class FinalTestAlreadySpentError extends Error {
  constructor(public readonly hypothesisId: string) {
    super(
      `Hypothesis ${hypothesisId} already has a FINAL_TEST experiment in progress or completed. ` +
        "Per docs/research-methodology.md, a final-test dataset is not renewable — propose a new " +
        "hypothesis (a fork of this one) if a fresh final-test period is needed.",
    );
    this.name = "FinalTestAlreadySpentError";
  }
}

export class ResearchStageOrderError extends Error {
  constructor(
    public readonly hypothesisId: string,
    public readonly requestedRole: string,
    public readonly reason: string,
  ) {
    super(`Cannot create a ${requestedRole} experiment for hypothesis ${hypothesisId}: ${reason}`);
    this.name = "ResearchStageOrderError";
  }
}

export class ResearchBudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`Research experiment budget exceeded: ${reason}`);
    this.name = "ResearchBudgetExceededError";
  }
}
```

- [ ] **Step 4: Implement the repository**

```typescript
// packages/database/src/repositories/research.ts
import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import type { EnrichedJournalTrade } from "@trading-copilot/analytics";
import type {
  AgentExecution,
  AgentExecutionStatus,
  AIProviderType,
  HypothesisConfidence,
  ResearchDatasetRole,
  ResearchExperiment,
  ResearchHypothesis,
} from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { FinalTestAlreadySpentError, ResearchStageOrderError } from "../errors";
import { mapAgentExecution, mapJournalTrade, mapMarketSnapshot, mapResearchExperiment, mapResearchHypothesis } from "../mappers";

const DATASET_ROLE_ORDER: ResearchDatasetRole[] = ["RESEARCH", "VALIDATION", "FINAL_TEST", "WALK_FORWARD"];

async function createAgentExecution(input: {
  agentType: "RESEARCH";
  provider: AIProviderType;
  model: string;
  promptVersion: string;
  inputSummary: Record<string, unknown>;
}): Promise<AgentExecution> {
  const row = await prisma.agentExecution.create({
    data: {
      agentType: input.agentType,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      inputSummary: input.inputSummary as Prisma.InputJsonValue,
      status: "RUNNING",
    },
  });
  return mapAgentExecution(row);
}

async function markAgentExecutionSucceeded(
  id: string,
  output: {
    outputRaw: string;
    outputParsed: Record<string, unknown>;
    tokensInput: number;
    tokensOutput: number;
    costUsd: Decimal;
  },
): Promise<AgentExecution> {
  const row = await prisma.agentExecution.update({
    where: { id },
    data: {
      status: "SUCCEEDED",
      outputRaw: output.outputRaw,
      outputParsed: output.outputParsed as Prisma.InputJsonValue,
      tokensInput: output.tokensInput,
      tokensOutput: output.tokensOutput,
      costUsd: output.costUsd.toString(),
      completedAt: new Date(),
    },
  });
  return mapAgentExecution(row);
}

async function markAgentExecutionFailed(
  id: string,
  failure: { outputRaw: string | null; errorMessage: string },
): Promise<AgentExecution> {
  const row = await prisma.agentExecution.update({
    where: { id },
    data: {
      status: "FAILED",
      outputRaw: failure.outputRaw,
      errorMessage: failure.errorMessage,
      completedAt: new Date(),
    },
  });
  return mapAgentExecution(row);
}

async function getAgentExecution(id: string): Promise<AgentExecution | null> {
  const row = await prisma.agentExecution.findUnique({ where: { id } });
  return row ? mapAgentExecution(row) : null;
}

async function listAgentExecutions(): Promise<AgentExecution[]> {
  const rows = await prisma.agentExecution.findMany({ orderBy: { startedAt: "desc" } });
  return rows.map(mapAgentExecution);
}

async function createResearchHypothesis(input: {
  agentExecutionId: string;
  title: string;
  statement: string;
  rationale: string;
  confidence: HypothesisConfidence;
  sourceDataSummary: Record<string, unknown>;
  proposedStrategyDefinition: Record<string, unknown>;
}): Promise<ResearchHypothesis> {
  const row = await prisma.researchHypothesis.create({
    data: {
      agentExecutionId: input.agentExecutionId,
      title: input.title,
      statement: input.statement,
      rationale: input.rationale,
      confidence: input.confidence,
      sourceDataSummary: input.sourceDataSummary as Prisma.InputJsonValue,
      proposedStrategyDefinition: input.proposedStrategyDefinition as Prisma.InputJsonValue,
      status: "PROPOSED",
    },
  });
  return mapResearchHypothesis(row);
}

async function getResearchHypothesis(id: string): Promise<ResearchHypothesis | null> {
  const row = await prisma.researchHypothesis.findUnique({ where: { id } });
  return row ? mapResearchHypothesis(row) : null;
}

async function listResearchHypotheses(): Promise<ResearchHypothesis[]> {
  const rows = await prisma.researchHypothesis.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(mapResearchHypothesis);
}

/**
 * Enforces dataset-role stage ordering (RESEARCH -> VALIDATION -> FINAL_TEST
 * -> WALK_FORWARD, each requiring a prior-stage COMPLETED experiment) and
 * relies on the partial unique index from the Task 1 migration for the
 * final-test reuse safeguard — translating its P2002 into a typed
 * FinalTestAlreadySpentError rather than letting a raw Prisma error escape.
 */
async function createResearchExperiment(input: {
  hypothesisId: string;
  datasetRole: ResearchDatasetRole;
  datasetWindowStart: Date;
  datasetWindowEnd: Date;
  backtestId?: string;
}): Promise<ResearchExperiment> {
  const roleIndex = DATASET_ROLE_ORDER.indexOf(input.datasetRole);
  if (roleIndex > 0) {
    const priorRole = DATASET_ROLE_ORDER[roleIndex - 1]!;
    const priorCompleted = await prisma.researchExperiment.findFirst({
      where: { hypothesisId: input.hypothesisId, datasetRole: priorRole, status: "COMPLETED" },
    });
    if (!priorCompleted) {
      throw new ResearchStageOrderError(
        input.hypothesisId,
        input.datasetRole,
        `no COMPLETED ${priorRole} experiment exists yet for this hypothesis`,
      );
    }
  }

  try {
    const row = await prisma.researchExperiment.create({
      data: {
        hypothesisId: input.hypothesisId,
        datasetRole: input.datasetRole,
        datasetWindowStart: input.datasetWindowStart,
        datasetWindowEnd: input.datasetWindowEnd,
        backtestId: input.backtestId ?? null,
        status: "QUEUED",
      },
    });
    return mapResearchExperiment(row);
  } catch (error) {
    const prismaError = error as { code?: string; meta?: { target?: unknown } };
    if (
      prismaError.code === "P2002" &&
      typeof prismaError.meta?.target === "string" &&
      prismaError.meta.target.includes("final_test")
    ) {
      throw new FinalTestAlreadySpentError(input.hypothesisId);
    }
    throw error;
  }
}

async function markResearchExperimentCompleted(id: string, backtestId: string): Promise<ResearchExperiment> {
  const row = await prisma.researchExperiment.update({
    where: { id },
    data: { status: "COMPLETED", backtestId, completedAt: new Date() },
  });
  return mapResearchExperiment(row);
}

async function markResearchExperimentFailed(id: string, failureReason: string): Promise<ResearchExperiment> {
  const row = await prisma.researchExperiment.update({
    where: { id },
    data: { status: "FAILED", failureReason, completedAt: new Date() },
  });
  return mapResearchExperiment(row);
}

async function listResearchExperimentsForHypothesis(hypothesisId: string): Promise<ResearchExperiment[]> {
  const rows = await prisma.researchExperiment.findMany({
    where: { hypothesisId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapResearchExperiment);
}

/** Sums today's (UTC) AgentExecution spend — used by ResearchService.assertWithinBudget before enqueueing a new agent job. */
async function getTodayResearchSpend(): Promise<{ tokensUsed: number; costUsd: Decimal }> {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.agentExecution.findMany({
    where: { startedAt: { gte: startOfDayUtc } },
    select: { tokensInput: true, tokensOutput: true, costUsd: true },
  });

  const tokensUsed = rows.reduce((sum, row) => sum + (row.tokensInput ?? 0) + (row.tokensOutput ?? 0), 0);
  const costUsd = rows.reduce(
    (sum, row) => sum.plus(row.costUsd ? new Decimal(row.costUsd.toString()) : 0),
    new Decimal(0),
  );

  return { tokensUsed, costUsd };
}

/**
 * Joins JournalTrade -> Setup -> MarketSnapshot to attach regime/session/
 * VWAP-distance context. A JournalTrade with no setupId (a purely manual
 * entry) or whose Setup has no marketSnapshot yields context: null — see
 * EnrichedJournalTrade's doc comment in packages/analytics.
 */
async function listEnrichedJournalTradesForResearch(filter: {
  strategyId?: string;
  instrumentId?: string;
  windowStart?: Date;
  windowEnd?: Date;
}): Promise<EnrichedJournalTrade[]> {
  const rows = await prisma.journalTrade.findMany({
    where: {
      status: "CLOSED",
      ...(filter.strategyId ? { strategyId: filter.strategyId } : {}),
      ...(filter.instrumentId ? { instrumentId: filter.instrumentId } : {}),
      ...(filter.windowStart || filter.windowEnd
        ? {
            entryTimestamp: {
              ...(filter.windowStart ? { gte: filter.windowStart } : {}),
              ...(filter.windowEnd ? { lte: filter.windowEnd } : {}),
            },
          }
        : {}),
    },
    include: { setup: { include: { marketSnapshot: true } } },
    orderBy: { entryTimestamp: "asc" },
  });

  return rows.map((row) => {
    const normalized = mapJournalTrade(row);
    const marketSnapshot = row.setup?.marketSnapshot ? mapMarketSnapshot(row.setup.marketSnapshot) : null;
    return {
      source: "JOURNAL" as const,
      id: normalized.id,
      strategyId: normalized.strategyId,
      strategyVersionId: normalized.strategyVersionId,
      instrumentId: normalized.instrumentId,
      direction: normalized.direction,
      executionMode: normalized.executionMode,
      entryTimestamp: normalized.entryTimestamp as Date,
      exitTimestamp: normalized.exitTimestamp as Date,
      entryPrice: normalized.actualEntry as Decimal,
      exitPrice: normalized.actualExit as Decimal,
      quantity: normalized.quantity as number,
      grossPnl: normalized.grossPnl as Decimal,
      fees: normalized.actualFees as Decimal,
      netPnl: normalized.netPnl as Decimal,
      riskAmount: normalized.plannedRisk,
      rMultiple: normalized.rMultiple,
      mfe: normalized.mfe,
      mae: normalized.mae,
      slippage: normalized.actualSlippage,
      context: marketSnapshot
        ? {
            session: marketSnapshot.session,
            timeOfDay: marketSnapshot.timeOfDay,
            marketRegime: marketSnapshot.marketRegime,
            vwapDistance: marketSnapshot.vwapDistance,
            volumePercentile: marketSnapshot.volumePercentile,
            atrPercentile: marketSnapshot.atrPercentile,
          }
        : null,
    };
  });
}

export const researchRepository = {
  createAgentExecution,
  markAgentExecutionSucceeded,
  markAgentExecutionFailed,
  getAgentExecution,
  listAgentExecutions,
  createResearchHypothesis,
  getResearchHypothesis,
  listResearchHypotheses,
  createResearchExperiment,
  markResearchExperimentCompleted,
  markResearchExperimentFailed,
  listResearchExperimentsForHypothesis,
  getTodayResearchSpend,
  listEnrichedJournalTradesForResearch,
};
```

Before finalizing this step, open `packages/database/src/repositories/journal-trades.ts` and `packages/database/src/mappers.ts` to confirm the exact field names `mapJournalTrade` returns (e.g. `actualEntry`/`actualExit`/`actualFees`/`actualSlippage`/`plannedRisk` vs. alternate names) and adjust the mapping block above to match exactly — do not guess field names that were not directly confirmed against the read source.

Modify `packages/database/src/index.ts` to add `export * from "./repositories/research";` and confirm `@trading-copilot/analytics` is added as a dependency in `packages/database/package.json`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/database test -- research.integration`
Expected: PASS

- [ ] **Step 6: Typecheck the whole package**

Run: `pnpm --filter @trading-copilot/database typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/errors.ts packages/database/src/repositories/research.ts packages/database/src/research.integration.test.ts packages/database/src/index.ts packages/database/package.json
git commit -m "feat(database): add research repository — hypotheses, experiments, AgentExecution, enriched journal trades, budget queries"
```

---

## Phase B — Parallel independent work (backend-engineer's lane is internally sequential; frontend-engineer's lane runs independently of it)

### Task 6: packages/ai-provider — AIProvider interface, MockAIProvider, structured hypothesis schema

**Owner:** backend-engineer

**Files:**
- Create: `packages/ai-provider/package.json`, `packages/ai-provider/tsconfig.json`
- Create: `packages/ai-provider/src/index.ts`, `packages/ai-provider/src/types.ts`, `packages/ai-provider/src/hypothesis-schema.ts`, `packages/ai-provider/src/mock-provider.ts`
- Test: `packages/ai-provider/src/mock-provider.test.ts`

**Interfaces:**
- Consumes: `strategyDefinitionSchema` (`@trading-copilot/strategy-engine`).
- Produces: `AI_PROVIDER_PROMPT_VERSION`, `researchHypothesisOutputSchema`/`ResearchHypothesisOutput` (`./hypothesis-schema`). `AIProvider`, `AIProviderResult<T>`, `ResearchAgentPromptInput` (`./types`). `MockAIProvider` (`./mock-provider`), implementing `AIProvider`.

- [ ] **Step 1: Scaffold the package**

```json
// packages/ai-provider/package.json
{
  "name": "@trading-copilot/ai-provider",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "@trading-copilot/strategy-engine": "workspace:*",
    "decimal.js": "^10.4.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

(Confirm the exact `zod` version pin against `packages/strategy-engine/package.json`'s own `zod` dependency before writing this file, and use that exact version string instead of the illustrative one above.)

```json
// packages/ai-provider/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Run: `pnpm install` (from repo root, to link the new workspace package)

- [ ] **Step 2: Write the failing MockAIProvider test**

```typescript
// packages/ai-provider/src/mock-provider.test.ts
import { describe, expect, it } from "vitest";
import { MockAIProvider } from "./mock-provider";
import { researchHypothesisOutputSchema } from "./hypothesis-schema";

describe("MockAIProvider", () => {
  it("produces a schema-valid hypothesis with no network access", async () => {
    const provider = new MockAIProvider();
    const result = await provider.generateResearchHypothesis({
      summary: {
        overall: { tradeCount: 120, winRate: "0.55", averageR: "0.8", expectancy: "12.5", profitFactor: "1.6" },
        bySession: [{ value: "LONDON", sampleSize: 60, winRate: "0.6", averageR: "1.1", profitFactor: "1.9" }],
      },
    });

    expect(() => researchHypothesisOutputSchema.parse(result.output)).not.toThrow();
    expect(result.model).toBe("mock-v1");
    expect(result.tokensInput).toBeGreaterThan(0);
    expect(result.costUsd.toString()).toBe("0");
  });

  it("is deterministic: identical input produces byte-identical output", async () => {
    const provider = new MockAIProvider();
    const input = { summary: { overall: { tradeCount: 10, winRate: "0.5", averageR: "0.1", expectancy: "1", profitFactor: null } } };
    const first = await provider.generateResearchHypothesis(input);
    const second = await provider.generateResearchHypothesis(input);
    expect(first.rawResponse).toBe(second.rawResponse);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/ai-provider test`
Expected: FAIL — files do not exist.

- [ ] **Step 4: Implement the hypothesis schema**

```typescript
// packages/ai-provider/src/hypothesis-schema.ts
import { z } from "zod";
import { strategyDefinitionSchema } from "@trading-copilot/strategy-engine";

/**
 * Bumped whenever the required shape of a ResearchAgent output changes in a
 * way that should not silently reinterpret old AgentExecution.outputParsed
 * rows — mirrors NOTIFICATION_TEMPLATE_VERSION's role.
 */
export const AI_PROVIDER_PROMPT_VERSION = "1.0.0";

/**
 * What every AIProvider implementation must return, schema-validated
 * before it is ever persisted as a ResearchHypothesis. The AI proposes a
 * RESEARCH-stage hypothesis only — it never picks its own VALIDATION/
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
```

- [ ] **Step 5: Implement the provider interface**

```typescript
// packages/ai-provider/src/types.ts
import Decimal from "decimal.js";
import type { ResearchHypothesisOutput } from "./hypothesis-schema";

/**
 * A pre-built deterministic summary (packages/analytics'
 * ResearchDataSummary, serialized to plain JSON-safe values) — the only
 * thing a provider implementation ever sees. No raw candles, no Decimal
 * instances (already stringified by the caller), matching docs/ai-research.md
 * "The ResearchAgent consumes summaries, not millions of raw candles."
 */
export interface ResearchAgentPromptInput {
  summary: Record<string, unknown>;
}

export interface AIProviderResult<T> {
  output: T;
  rawResponse: string;
  promptVersion: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: Decimal;
}

export interface AIProvider {
  readonly type: "MOCK" | "ANTHROPIC";
  generateResearchHypothesis(
    input: ResearchAgentPromptInput,
  ): Promise<AIProviderResult<ResearchHypothesisOutput>>;
}
```

- [ ] **Step 6: Implement MockAIProvider**

```typescript
// packages/ai-provider/src/mock-provider.ts
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { AI_PROVIDER_PROMPT_VERSION, researchHypothesisOutputSchema } from "./hypothesis-schema";
import type { AIProvider, AIProviderResult, ResearchAgentPromptInput } from "./types";

/**
 * Fully deterministic, zero-network AIProvider — the default whenever
 * ANTHROPIC_API_KEY is unset, and always used by automated tests/CI. Seeds
 * its output from a hash of the input so identical input always produces
 * byte-identical output, satisfying the "deterministic mock AI mode"
 * requirement without ever making the mock's hypothesis content
 * meaningful — it is a structural stand-in for tests and dry runs, never a
 * real research conclusion.
 */
export class MockAIProvider implements AIProvider {
  readonly type = "MOCK" as const;

  async generateResearchHypothesis(
    input: ResearchAgentPromptInput,
  ): Promise<AIProviderResult<import("./hypothesis-schema").ResearchHypothesisOutput>> {
    const seed = createHash("sha256").update(JSON.stringify(input.summary)).digest("hex").slice(0, 8);

    const rawOutput = {
      title: `Mock hypothesis ${seed}`,
      statement: `Deterministic mock statement generated from input hash ${seed}. Not a real research conclusion.`,
      rationale: "Generated by MockAIProvider for testing — no real data interpretation occurred.",
      confidence: "LOW" as const,
      proposedStrategyDefinition: {
        version: "1.0.0" as const,
        direction: "LONG" as const,
        entryRules: [{ type: "EMA_CROSS_ABOVE" as const, fastPeriod: 20, slowPeriod: 50 }],
        atrPeriod: 14,
        stopAtrMultiplier: 1,
        targetAtrMultiplier: 2,
      },
    };

    const output = researchHypothesisOutputSchema.parse(rawOutput);
    const rawResponse = JSON.stringify(rawOutput);

    return {
      output,
      rawResponse,
      promptVersion: AI_PROVIDER_PROMPT_VERSION,
      model: "mock-v1",
      tokensInput: JSON.stringify(input.summary).length,
      tokensOutput: rawResponse.length,
      costUsd: new Decimal(0),
    };
  }
}
```

```typescript
// packages/ai-provider/src/index.ts
export * from "./types";
export * from "./hypothesis-schema";
export * from "./mock-provider";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/ai-provider test && pnpm --filter @trading-copilot/ai-provider typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/ai-provider
git commit -m "feat(ai-provider): add AIProvider interface, structured hypothesis schema, deterministic MockAIProvider"
```

---

### Task 7: ResearchAgent (apps/worker, no BullMQ dependency)

**Owner:** backend-engineer

**Files:**
- Create: `apps/worker/src/research/research-agent.ts`
- Test: `apps/worker/src/research/research-agent.test.ts`

**Interfaces:**
- Consumes: `AIProvider`, `MockAIProvider` (`@trading-copilot/ai-provider`, Task 6); `ResearchDataSummary` (`@trading-copilot/analytics`, Task 4).
- Produces: `ResearchAgent` class with `generateHypothesis(summary: ResearchDataSummary): Promise<AIProviderResult<ResearchHypothesisOutput>>`, constructed with an injected `AIProvider` (no BullMQ, no Prisma — unit-testable in isolation).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/research/research-agent.test.ts
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { MockAIProvider } from "@trading-copilot/ai-provider";
import type { ResearchDataSummary } from "@trading-copilot/analytics";
import { ResearchAgent } from "./research-agent";

function emptySummary(): ResearchDataSummary {
  return {
    overall: {
      tradeCount: 0, wins: 0, losses: 0, winRate: new Decimal(0), grossProfit: new Decimal(0),
      grossLoss: new Decimal(0), netPnl: new Decimal(0), averagePnl: new Decimal(0), expectancy: new Decimal(0),
      averageR: new Decimal(0), profitFactor: null, averageWinner: new Decimal(0), averageLoser: new Decimal(0),
      largestWinner: new Decimal(0), largestLoser: new Decimal(0), maxDrawdown: new Decimal(0),
      maxDrawdownPercent: null, maximumConsecutiveWins: 0, maximumConsecutiveLosses: 0, mfeAverage: null,
      maeAverage: null, totalFees: new Decimal(0), averageSlippage: null,
    },
    sampleWindowStart: null, sampleWindowEnd: null, bySession: [], byTimeOfDay: [], byMarketRegime: [],
    byDirection: [], vwapDistance: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
    volumePercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
    atrPercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
  };
}

describe("ResearchAgent", () => {
  it("serializes a ResearchDataSummary into JSON-safe input and returns a schema-valid hypothesis", async () => {
    const agent = new ResearchAgent(new MockAIProvider());
    const result = await agent.generateHypothesis(emptySummary());
    expect(result.output.title.length).toBeGreaterThan(0);
    expect(result.model).toBe("mock-v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/worker test -- research-agent`
Expected: FAIL — `./research-agent` does not exist.

- [ ] **Step 3: Implement**

```typescript
// apps/worker/src/research/research-agent.ts
import type { AIProvider, AIProviderResult, ResearchHypothesisOutput } from "@trading-copilot/ai-provider";
import type { ResearchDataSummary } from "@trading-copilot/analytics";

/**
 * Serializes every Decimal in a ResearchDataSummary to a plain string so
 * the AIProvider boundary never receives a Decimal instance — see
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
 * Composes a deterministic ResearchDataSummary into a provider call and
 * hands back its validated result. Deliberately has no BullMQ or Prisma
 * dependency — AgentExecutionProcessor (Task 8) is the only caller, and it
 * owns all persistence; this class is pure orchestration + serialization,
 * unit-testable with MockAIProvider alone.
 */
export class ResearchAgent {
  constructor(private readonly provider: AIProvider) {}

  async generateHypothesis(summary: ResearchDataSummary): Promise<AIProviderResult<ResearchHypothesisOutput>> {
    const jsonSafeSummary = toJsonSafe(summary) as Record<string, unknown>;
    return this.provider.generateResearchHypothesis({ summary: jsonSafeSummary });
  }
}
```

- [ ] **Step 4: Run test to verify it passes, and typecheck**

Run: `pnpm --filter @trading-copilot/worker test -- research-agent && pnpm --filter @trading-copilot/worker typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/research/research-agent.ts apps/worker/src/research/research-agent.test.ts
git commit -m "feat(worker): add ResearchAgent — deterministic-summary-to-hypothesis orchestration, no BullMQ/Prisma dependency"
```

---

### Task 8: AgentExecutionProcessor (BullMQ) + apps/worker wiring + journal events

**Owner:** backend-engineer

**Files:**
- Create: `apps/worker/src/research/agent-execution.processor.ts`
- Create: `apps/worker/src/research/ai-provider.factory.ts`
- Modify: `apps/worker/src/app.module.ts`
- Test: `apps/worker/src/research/agent-execution.processor.test.ts`

**Interfaces:**
- Consumes: `RESEARCH_AGENT_QUEUE`, `RUN_RESEARCH_AGENT_JOB`, `RESEARCH_AGENT_JOB_OPTIONS`, `ResearchAgentJobPayload` (`@trading-copilot/shared-types`, Task 2); `researchRepository` (`@trading-copilot/database`, Task 5); `ResearchAgent` (`./research-agent`, Task 7); `MockAIProvider`, `AIProvider` (`@trading-copilot/ai-provider`, Task 6); `journalEventsRepository.recordEvent` (existing — confirm its exact signature by reading `packages/database/src/repositories/journal-events.ts` before writing this step, and match it exactly).
- Produces: `createAIProviderFromEnv(): AIProvider` (`./ai-provider.factory`). `AgentExecutionProcessor` (`@Processor(RESEARCH_AGENT_QUEUE)`), registered in `apps/worker/src/app.module.ts`.

- [ ] **Step 1: Write the failing processor test**

```typescript
// apps/worker/src/research/agent-execution.processor.test.ts
import { describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@trading-copilot/ai-provider";
import { AgentExecutionProcessor } from "./agent-execution.processor";

const baseSummary = {
  overall: { tradeCount: 0 },
  sampleWindowStart: null,
  sampleWindowEnd: null,
  bySession: [],
  byTimeOfDay: [],
  byMarketRegime: [],
  byDirection: [],
  vwapDistance: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
  volumePercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
  atrPercentile: { averageAmongWinners: null, averageAmongLosers: null, averageAmongAll: null },
};

function makeResearchRepositoryMock(agentExecution: { id: string; inputSummary: unknown }) {
  return {
    getAgentExecution: vi.fn().mockResolvedValue(agentExecution),
    markAgentExecutionSucceeded: vi.fn().mockResolvedValue({ ...agentExecution, status: "SUCCEEDED" }),
    markAgentExecutionFailed: vi.fn().mockResolvedValue({ ...agentExecution, status: "FAILED" }),
    createResearchHypothesis: vi.fn().mockResolvedValue({ id: "hyp-1" }),
  };
}

describe("AgentExecutionProcessor", () => {
  it("on success: persists the hypothesis, marks the execution SUCCEEDED, records a journal event", async () => {
    const agentExecution = { id: "exec-1", inputSummary: baseSummary };
    const researchRepositoryMock = makeResearchRepositoryMock(agentExecution);
    const recordEvent = vi.fn().mockResolvedValue(undefined);

    const processor = new AgentExecutionProcessor(
      researchRepositoryMock as never,
      new MockAIProvider(),
      { recordEvent } as never,
    );

    await processor.process({ data: { agentExecutionId: "exec-1" } } as never);

    expect(researchRepositoryMock.createResearchHypothesis).toHaveBeenCalledTimes(1);
    expect(researchRepositoryMock.markAgentExecutionSucceeded).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_COMPLETED", entityType: "AGENT_EXECUTION", entityId: "exec-1" }),
    );
  });

  it("throws if the AgentExecution row cannot be found (never silently no-ops)", async () => {
    const researchRepositoryMock = { getAgentExecution: vi.fn().mockResolvedValue(null) };
    const processor = new AgentExecutionProcessor(researchRepositoryMock as never, new MockAIProvider(), {
      recordEvent: vi.fn(),
    } as never);

    await expect(processor.process({ data: { agentExecutionId: "missing" } } as never)).rejects.toThrow();
  });
});
```

Before finalizing this test, open `packages/database/src/repositories/journal-events.ts` to confirm `recordEvent`'s exact parameter names (`eventType`/`entityType`/`entityId` vs. alternates) and adjust the `expect.objectContaining` call and the processor implementation in Step 3 to match exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/worker test -- agent-execution.processor`
Expected: FAIL — `./agent-execution.processor` does not exist.

- [ ] **Step 3: Implement the provider factory and processor**

```typescript
// apps/worker/src/research/ai-provider.factory.ts
import type { AIProvider } from "@trading-copilot/ai-provider";
import { MockAIProvider } from "@trading-copilot/ai-provider";

/**
 * MOCK is the default whenever ANTHROPIC_API_KEY is unset — see
 * docs/ai-research.md "Provider selection". AnthropicAIProvider (Task 9)
 * plugs into this same factory once it exists; until Task 9 lands, setting
 * ANTHROPIC_API_KEY has no effect and the factory still returns
 * MockAIProvider (this file is re-modified in Task 9's Step 3).
 */
export function createAIProviderFromEnv(): AIProvider {
  return new MockAIProvider();
}
```

```typescript
// apps/worker/src/research/agent-execution.processor.ts
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Job } from "bullmq";
import type { AIProvider } from "@trading-copilot/ai-provider";
import { researchRepository } from "@trading-copilot/database";
import { RESEARCH_AGENT_QUEUE, type ResearchAgentJobPayload } from "@trading-copilot/shared-types";
import { journalEventsRepository } from "@trading-copilot/database";
import { ResearchAgent } from "./research-agent";
import { createAIProviderFromEnv } from "./ai-provider.factory";

export const AI_PROVIDER = "AI_PROVIDER";

export const aiProviderProvider = {
  provide: AI_PROVIDER,
  useFactory: createAIProviderFromEnv,
};

/**
 * Loads the RUNNING AgentExecution row written synchronously by
 * apps/api/src/research/research.service.ts BEFORE this job was enqueued
 * (so the audit trail exists even if this job never starts), calls
 * ResearchAgent, and persists the outcome. Never silently no-ops: a
 * missing AgentExecution row is a real bug (the row must exist before the
 * job can) and throws rather than swallowing.
 */
@Injectable()
@Processor(RESEARCH_AGENT_QUEUE)
export class AgentExecutionProcessor extends WorkerHost {
  constructor(
    @Inject("RESEARCH_REPOSITORY") private readonly research: typeof researchRepository,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
    @Inject("JOURNAL_EVENTS_REPOSITORY") private readonly journalEvents: typeof journalEventsRepository,
  ) {
    super();
  }

  async process(job: Job<ResearchAgentJobPayload>): Promise<void> {
    const { agentExecutionId } = job.data;
    const execution = await this.research.getAgentExecution(agentExecutionId);
    if (!execution) {
      throw new Error(`AgentExecution ${agentExecutionId} not found — it must be created before enqueueing`);
    }

    await this.journalEvents.recordEvent({
      eventType: "AGENT_STARTED",
      entityType: "AGENT_EXECUTION",
      entityId: agentExecutionId,
      payload: { provider: execution.provider },
    });

    try {
      const agent = new ResearchAgent(this.aiProvider);
      const result = await agent.generateHypothesis(execution.inputSummary as never);

      const hypothesis = await this.research.createResearchHypothesis({
        agentExecutionId,
        title: result.output.title,
        statement: result.output.statement,
        rationale: result.output.rationale,
        confidence: result.output.confidence,
        sourceDataSummary: execution.inputSummary,
        proposedStrategyDefinition: result.output.proposedStrategyDefinition,
      });

      await this.research.markAgentExecutionSucceeded(agentExecutionId, {
        outputRaw: result.rawResponse,
        outputParsed: result.output,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        costUsd: result.costUsd,
      });

      await this.journalEvents.recordEvent({
        eventType: "AGENT_COMPLETED",
        entityType: "AGENT_EXECUTION",
        entityId: agentExecutionId,
        payload: { hypothesisId: hypothesis.id },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.research.markAgentExecutionFailed(agentExecutionId, { outputRaw: null, errorMessage: message });
      await this.journalEvents.recordEvent({
        eventType: "AGENT_FAILED",
        entityType: "AGENT_EXECUTION",
        entityId: agentExecutionId,
        payload: { errorMessage: message },
      });
      throw error;
    }
  }
}
```

Before finalizing, open `apps/worker/src/notifications/notification-send.processor.ts` (an existing `@Processor` in this codebase) to confirm the exact NestJS BullMQ processor base-class/decorator pattern this project actually uses (`WorkerHost`/`@Processor`/`process()` vs. an alternate `@Process()`-per-method style), and the exact DI-token convention for injecting repository objects (some of this project's modules may inject plain repository modules directly rather than via string tokens) — adjust the constructor/decorators above to match that established pattern exactly rather than the illustrative token names shown here.

Modify `apps/worker/src/app.module.ts`: add `import { RESEARCH_AGENT_QUEUE, RESEARCH_AGENT_JOB_OPTIONS } from "@trading-copilot/shared-types";`, add `BullModule.registerQueue({ name: RESEARCH_AGENT_QUEUE, defaultJobOptions: RESEARCH_AGENT_JOB_OPTIONS })` to `imports`, and add `aiProviderProvider, AgentExecutionProcessor` to `providers` (following the exact pattern `notificationProviderProvider, NotificationSendProcessor` already use in that file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/worker test -- agent-execution.processor && pnpm --filter @trading-copilot/worker typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/research apps/worker/src/app.module.ts
git commit -m "feat(worker): add AgentExecutionProcessor, register RESEARCH_AGENT_QUEUE, wire journal events"
```

---

### Task 9: apps/api research module — trigger, list/detail, experiment creation, budgets, mark-paper-candidate

**Owner:** backend-engineer

**Files:**
- Create: `apps/api/src/research/research.module.ts`, `research.service.ts`, `research.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/common/domain-error.filter.ts`
- Test: `apps/api/src/research/research.service.test.ts`

**Interfaces:**
- Consumes: `researchRepository` (`@trading-copilot/database`, Task 5); `buildResearchDataSummary`, `assertSampleSizeGuardrails` (`@trading-copilot/analytics`, Task 4); `generateResearchHypothesisRequestSchema`, `createResearchExperimentRequestSchema`, `markPaperCandidateRequestSchema`, `RESEARCH_AGENT_QUEUE`, `RUN_RESEARCH_AGENT_JOB` (`@trading-copilot/shared-types`, Task 2); `backtestsRepository.createBacktest`, `strategiesRepository.createStrategyVersion`, `instrumentsRepository.getInstrument` (existing, `@trading-copilot/database`, per `backtest.service.ts`'s and `strategies.ts`'s confirmed signatures); `FinalTestAlreadySpentError`, `ResearchStageOrderError`, `ResearchBudgetExceededError` (`@trading-copilot/database`, Task 5).
- Produces: `ResearchService` with `generateHypothesis(input)`, `listHypotheses()`, `getHypothesis(id)`, `createExperiment(hypothesisId, input)`, `markPaperCandidate(hypothesisId, strategyVersionId)`. `ResearchController`: `POST /research/hypotheses/generate`, `GET /research/hypotheses`, `GET /research/hypotheses/:id`, `POST /research/hypotheses/:id/experiments`, `POST /research/hypotheses/:id/strategy-versions/:versionId/mark-paper-candidate`.

- [ ] **Step 1: Write the failing budget-enforcement test**

```typescript
// apps/api/src/research/research.service.test.ts
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import { ResearchBudgetExceededError } from "@trading-copilot/database";
import { ResearchService } from "./research.service";

const RESEARCH_DAILY_TOKEN_BUDGET_ENV = "RESEARCH_DAILY_TOKEN_BUDGET";

describe("ResearchService.generateHypothesis", () => {
  it("throws ResearchBudgetExceededError when today's token spend already meets the configured budget", async () => {
    process.env[RESEARCH_DAILY_TOKEN_BUDGET_ENV] = "1000";

    const researchRepositoryMock = {
      getTodayResearchSpend: vi.fn().mockResolvedValue({ tokensUsed: 1000, costUsd: new Decimal(0) }),
      createAgentExecution: vi.fn(),
      listEnrichedJournalTradesForResearch: vi.fn(),
    };
    const queueMock = { add: vi.fn() };

    const service = new ResearchService(researchRepositoryMock as never, queueMock as never);

    await expect(service.generateHypothesis({})).rejects.toThrow(ResearchBudgetExceededError);
    expect(researchRepositoryMock.createAgentExecution).not.toHaveBeenCalled();

    delete process.env[RESEARCH_DAILY_TOKEN_BUDGET_ENV];
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/api test -- research.service`
Expected: FAIL — `./research.service` does not exist.

- [ ] **Step 3: Implement `ResearchService`**

```typescript
// apps/api/src/research/research.service.ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import Decimal from "decimal.js";
import {
  backtestsRepository,
  instrumentsRepository,
  researchRepository,
  strategiesRepository,
} from "@trading-copilot/database";
import { ResearchBudgetExceededError } from "@trading-copilot/database";
import { assertSampleSizeGuardrails, buildResearchDataSummary } from "@trading-copilot/analytics";
import {
  RESEARCH_AGENT_QUEUE,
  RUN_RESEARCH_AGENT_JOB,
  type CreateResearchExperimentRequestInput,
  type GenerateResearchHypothesisRequestInput,
} from "@trading-copilot/shared-types";
import type { AgentExecution, ResearchExperiment, ResearchHypothesis } from "@trading-copilot/trading-domain";

/** Configurable via env; a conservative default keeps an unattended loop from running up real API cost. */
function getDailyTokenBudget(): number {
  const raw = process.env.RESEARCH_DAILY_TOKEN_BUDGET;
  return raw ? Number.parseInt(raw, 10) : 200_000;
}

@Injectable()
export class ResearchService {
  constructor(
    @Inject("RESEARCH_REPOSITORY") private readonly research: typeof researchRepository = researchRepository,
    @InjectQueue(RESEARCH_AGENT_QUEUE) private readonly agentQueue: Queue<{ agentExecutionId: string }>,
  ) {}

  async generateHypothesis(input: GenerateResearchHypothesisRequestInput): Promise<AgentExecution> {
    const spend = await this.research.getTodayResearchSpend();
    const budget = getDailyTokenBudget();
    if (spend.tokensUsed >= budget) {
      throw new ResearchBudgetExceededError(
        `today's usage (${spend.tokensUsed} tokens) has already met the daily budget (${budget} tokens)`,
      );
    }

    const trades = await this.research.listEnrichedJournalTradesForResearch({
      strategyId: input.strategyId,
      instrumentId: input.instrumentId,
    });
    const summary = buildResearchDataSummary(trades);

    const provider = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC" : "MOCK";
    const execution = await this.research.createAgentExecution({
      agentType: "RESEARCH",
      provider,
      model: provider === "ANTHROPIC" ? "claude-sonnet-5" : "mock-v1",
      promptVersion: "1.0.0",
      inputSummary: summary as unknown as Record<string, unknown>,
    });

    await this.agentQueue.add(RUN_RESEARCH_AGENT_JOB, { agentExecutionId: execution.id });

    return execution;
  }

  listHypotheses(): Promise<ResearchHypothesis[]> {
    return this.research.listResearchHypotheses();
  }

  async getHypothesis(id: string) {
    const hypothesis = await this.research.getResearchHypothesis(id);
    if (!hypothesis) {
      throw new NotFoundException(`ResearchHypothesis ${id} not found`);
    }
    const experiments = await this.research.listResearchExperimentsForHypothesis(id);
    const agentExecution = await this.research.getAgentExecution(hypothesis.agentExecutionId);
    return { hypothesis, experiments, agentExecution };
  }

  /**
   * Creates the Backtest this experiment runs (reusing the unmodified
   * backtest pipeline entirely), a StrategyVersion the first time a
   * hypothesis is tested (status DISCOVERED, sourceHypothesisId set,
   * "ai-generated-dsl-v1" key), and the ResearchExperiment row itself —
   * dataset-role stage ordering and the final-test reuse safeguard are
   * both enforced inside researchRepository.createResearchExperiment
   * (Task 5).
   */
  async createExperiment(
    hypothesisId: string,
    input: CreateResearchExperimentRequestInput,
  ): Promise<ResearchExperiment> {
    const hypothesis = await this.research.getResearchHypothesis(hypothesisId);
    if (!hypothesis) {
      throw new NotFoundException(`ResearchHypothesis ${hypothesisId} not found`);
    }

    if (input.datasetRole !== "RESEARCH") {
      const priorTrades = await this.research.listEnrichedJournalTradesForResearch({
        windowEnd: new Date(input.datasetWindowStart),
      });
      const guardrails = assertSampleSizeGuardrails(buildResearchDataSummary(priorTrades));
      if (!guardrails.passes) {
        throw new ResearchBudgetExceededError(
          `sample-size guardrails not met before a ${input.datasetRole} experiment: ${guardrails.reasons.join("; ")}`,
        );
      }
    }

    const instrument = await instrumentsRepository.getInstrument(input.instrumentId);
    if (!instrument) {
      throw new NotFoundException(`Instrument ${input.instrumentId} not found`);
    }

    let strategy = await strategiesRepository.getStrategyByKey?.("ai-generated-dsl-v1");
    if (!strategy) {
      strategy = await strategiesRepository.createStrategy({
        key: "ai-generated-dsl-v1",
        name: "AI-generated DSL strategies",
        description: "Container Strategy for every AI-proposed StrategyDefinition — see docs/ai-research.md.",
      });
    }

    const strategyVersion = await strategiesRepository.createStrategyVersion({
      strategyId: strategy.id,
      version: hypothesis.id,
      name: hypothesis.title,
      description: hypothesis.statement,
      parameters: hypothesis.proposedStrategyDefinition,
      status: "DISCOVERED",
    });

    const backtest = await backtestsRepository.createBacktest({
      strategyVersionId: strategyVersion.id,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      startDate: new Date(input.datasetWindowStart),
      endDate: new Date(input.datasetWindowEnd),
      assumptions: {
        commissionPerContract: instrument.commissionPerContract.toString(),
        slippageTicks: input.slippageTicks,
        riskPercentage: input.riskPercentage,
        initialBalance: input.initialBalance,
      },
    });

    return this.research.createResearchExperiment({
      hypothesisId,
      datasetRole: input.datasetRole,
      datasetWindowStart: new Date(input.datasetWindowStart),
      datasetWindowEnd: new Date(input.datasetWindowEnd),
      backtestId: backtest.id,
    });
  }
}
```

Before finalizing this step: (a) open `packages/database/src/repositories/strategies.ts` in full to confirm whether a `getStrategyByKey`/`createStrategy` function already exists with these exact names and signatures — if the existing names differ, use the real ones instead of the illustrative ones above; (b) confirm `backtestsRepository.createBacktest`'s exact input shape against the already-read `apps/api/src/backtests/backtest.service.ts` (it matches `CreateBacktestRequestInput`'s fields exactly, already used above); (c) confirm whether `apps/api`'s existing NestJS providers are injected via plain class reference or a string token like `"RESEARCH_REPOSITORY"` by checking an existing service such as `apps/api/src/setups/setup.service.ts`'s constructor — this project may inject the plain module object directly rather than through DI tokens (repositories in this codebase are plain exported objects/functions, not `@Injectable` classes), in which case simplify `ResearchService`'s constructor to call `researchRepository`/`backtestsRepository`/etc. directly (module-level imports) exactly like `BacktestService` already does, and drop the `@Inject("RESEARCH_REPOSITORY")` token entirely — match the established convention, do not introduce a new DI-token pattern this codebase doesn't use.

- [ ] **Step 4: Implement the mark-paper-candidate transition**

```typescript
// apps/api/src/research/research.service.ts — add to the ResearchService class
import { ConflictException } from "@nestjs/common";
import { strategyVersionsRepository } from "@trading-copilot/database"; // confirm the exact repository/function name that performs an atomic conditional StrategyVersion status update before using this import — see the note below

  /**
   * Human-triggered only (see markPaperCandidateRequestSchema's
   * confirmedByHuman: true literal) — nothing in this plan auto-promotes a
   * StrategyVersion. Requires a COMPLETED WALK_FORWARD experiment and a
   * COMPLETED FINAL_TEST experiment to already exist for this hypothesis,
   * and the sample-size guardrails to pass over the combined dataset
   * window. Uses an atomic conditional update (status must currently be
   * WALK_FORWARD) — see docs/implementation-status.md's atomic-updateMany
   * convention from the Milestone 6 technical-debt pass.
   */
  async markPaperCandidate(hypothesisId: string, strategyVersionId: string): Promise<void> {
    const experiments = await this.research.listResearchExperimentsForHypothesis(hypothesisId);
    const hasCompletedFinalTest = experiments.some((e) => e.datasetRole === "FINAL_TEST" && e.status === "COMPLETED");
    const hasCompletedWalkForward = experiments.some(
      (e) => e.datasetRole === "WALK_FORWARD" && e.status === "COMPLETED",
    );
    if (!hasCompletedFinalTest || !hasCompletedWalkForward) {
      throw new ConflictException(
        "PAPER_CANDIDATE requires a COMPLETED FINAL_TEST experiment and a COMPLETED WALK_FORWARD experiment",
      );
    }

    const updated = await strategyVersionsRepository.markPaperCandidate(strategyVersionId);
    if (!updated) {
      throw new ConflictException(
        `StrategyVersion ${strategyVersionId} is not currently WALK_FORWARD — cannot mark PAPER_CANDIDATE`,
      );
    }
  }
```

This step depends on a small atomic-conditional-update repository function (`strategyVersionsRepository.markPaperCandidate(id): Promise<StrategyVersion | null>`, implemented as `updateMany({ where: { id, status: "WALK_FORWARD" }, data: { status: "PAPER_CANDIDATE" } })` followed by a re-fetch on `count === 1`, returning `null` on a miss) — add this function to `packages/database/src/repositories/strategies.ts` in this same task (it is a small, tightly-coupled addition, not large enough to warrant its own task), following the exact atomic-`updateMany`-then-recheck pattern already established in `journal-trades.ts`'s `closeJournalTrade` (from the post-Milestone-6 technical-debt pass) rather than a plain `update()`.

- [ ] **Step 5: Implement the controller and module**

```typescript
// apps/api/src/research/research.controller.ts
import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import {
  createResearchExperimentRequestSchema,
  generateResearchHypothesisRequestSchema,
  markPaperCandidateRequestSchema,
} from "@trading-copilot/shared-types";
import { ResearchService } from "./research.service";

@Controller("research")
export class ResearchController {
  constructor(private readonly researchService: ResearchService) {}

  @Post("hypotheses/generate")
  generate(@Body() body: unknown) {
    const input = generateResearchHypothesisRequestSchema.parse(body);
    return this.researchService.generateHypothesis(input);
  }

  @Get("hypotheses")
  list() {
    return this.researchService.listHypotheses();
  }

  @Get("hypotheses/:id")
  getById(@Param("id") id: string) {
    return this.researchService.getHypothesis(id);
  }

  @Post("hypotheses/:id/experiments")
  createExperiment(@Param("id") id: string, @Body() body: unknown) {
    const input = createResearchExperimentRequestSchema.parse(body);
    return this.researchService.createExperiment(id, input);
  }

  @Post("hypotheses/:id/strategy-versions/:versionId/mark-paper-candidate")
  async markPaperCandidate(@Param("id") id: string, @Param("versionId") versionId: string, @Body() body: unknown) {
    markPaperCandidateRequestSchema.parse(body);
    await this.researchService.markPaperCandidate(id, versionId);
    return { status: "PAPER_CANDIDATE" };
  }
}
```

```typescript
// apps/api/src/research/research.module.ts
import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { RESEARCH_AGENT_QUEUE } from "@trading-copilot/shared-types";
import { ResearchController } from "./research.controller";
import { ResearchService } from "./research.service";

@Module({
  imports: [BullModule.registerQueue({ name: RESEARCH_AGENT_QUEUE })],
  controllers: [ResearchController],
  providers: [ResearchService],
})
export class ResearchModule {}
```

Modify `apps/api/src/app.module.ts` to add `ResearchModule` to `imports`, following the existing pattern for `SetupModule`/`BacktestModule`/etc.

Modify `apps/api/src/common/domain-error.filter.ts` to also catch `FinalTestAlreadySpentError`, `ResearchStageOrderError`, and `ResearchBudgetExceededError`, mapping each to a `409 ConflictException`-style response with the error's own message — following the exact pattern already used there for `JournalTradeActiveDecisionConflictError`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/api test -- research.service && pnpm --filter @trading-copilot/api typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/research apps/api/src/app.module.ts apps/api/src/common/domain-error.filter.ts packages/database/src/repositories/strategies.ts
git commit -m "feat(api): add research module — hypothesis generation, experiment creation, budgets, human-gated PAPER_CANDIDATE transition"
```

---

### Task 10: AnthropicAIProvider (real provider, env-gated)

**Owner:** backend-engineer

**Files:**
- Create: `packages/ai-provider/src/anthropic-provider.ts`
- Modify: `packages/ai-provider/src/index.ts`, `packages/ai-provider/package.json`
- Modify: `apps/worker/src/research/ai-provider.factory.ts`
- Test: `packages/ai-provider/src/anthropic-provider.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/sdk` (new dependency); `researchHypothesisOutputSchema`, `AI_PROVIDER_PROMPT_VERSION` (`./hypothesis-schema`); `AIProvider`, `AIProviderResult`, `ResearchAgentPromptInput` (`./types`).
- Produces: `AnthropicAIProvider implements AIProvider`.

- [ ] **Step 1: Add the dependency**

```json
// packages/ai-provider/package.json — add to "dependencies"
"@anthropic-ai/sdk": "^0.32.1",
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test (mocking the SDK — never a real network call)**

```typescript
// packages/ai-provider/src/anthropic-provider.test.ts
import { describe, expect, it, vi } from "vitest";
import { AnthropicAIProvider } from "./anthropic-provider";

const VALID_TOOL_INPUT = {
  title: "Test hypothesis",
  statement: "A test statement long enough to pass validation.",
  rationale: "A test rationale.",
  confidence: "MEDIUM",
  proposedStrategyDefinition: {
    version: "1.0.0",
    direction: "LONG",
    entryRules: [{ type: "EMA_CROSS_ABOVE", fastPeriod: 20, slowPeriod: 50 }],
    atrPeriod: 14,
    stopAtrMultiplier: 1,
    targetAtrMultiplier: 2,
  },
};

function makeMockClient(toolInput: unknown) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "tool_use", name: "propose_research_hypothesis", input: toolInput }],
        usage: { input_tokens: 500, output_tokens: 300 },
        model: "claude-sonnet-5",
      }),
    },
  };
}

describe("AnthropicAIProvider", () => {
  it("parses a valid tool_use response into a schema-valid hypothesis with token/cost tracking", async () => {
    const client = makeMockClient(VALID_TOOL_INPUT);
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    const result = await provider.generateResearchHypothesis({ summary: { overall: { tradeCount: 10 } } });

    expect(result.output.title).toBe("Test hypothesis");
    expect(result.tokensInput).toBe(500);
    expect(result.tokensOutput).toBe(300);
    expect(result.costUsd.greaterThan(0)).toBe(true);
  });

  it("throws (never guesses) when the response fails schema validation", async () => {
    const client = makeMockClient({ title: "" });
    const provider = new AnthropicAIProvider(client as never, "claude-sonnet-5");

    await expect(provider.generateResearchHypothesis({ summary: {} })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @trading-copilot/ai-provider test -- anthropic-provider`
Expected: FAIL — `./anthropic-provider` does not exist.

- [ ] **Step 4: Implement**

```typescript
// packages/ai-provider/src/anthropic-provider.ts
import type Anthropic from "@anthropic-ai/sdk";
import Decimal from "decimal.js";
import { AI_PROVIDER_PROMPT_VERSION, researchHypothesisOutputSchema } from "./hypothesis-schema";
import type { AIProvider, AIProviderResult, ResearchAgentPromptInput } from "./types";

/**
 * Per-million-token pricing — update alongside AI_PROVIDER_PROMPT_VERSION
 * bumps if the configured model changes; kept as a named constant rather
 * than inline so cost tracking has one obvious place to audit.
 */
const INPUT_COST_PER_MILLION_TOKENS_USD = new Decimal(3);
const OUTPUT_COST_PER_MILLION_TOKENS_USD = new Decimal(15);

const RESEARCH_HYPOTHESIS_TOOL = {
  name: "propose_research_hypothesis",
  description: "Propose one testable trading-strategy research hypothesis from the given deterministic statistics.",
  input_schema: {
    type: "object" as const,
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
  "regime/direction) — never raw price data. You do not calculate any P&L, risk, or performance " +
  "number yourself; you only interpret the numbers you are given. Propose exactly one testable " +
  "hypothesis, expressed as a StrategyDefinition using only the EMA_CROSS_ABOVE, EMA_CROSS_BELOW, " +
  "CLOSE_ABOVE_EMA, and CLOSE_BELOW_EMA entry rule types. Call the propose_research_hypothesis tool " +
  "exactly once with your answer.";

/** Real provider — never used by automated tests (see MockAIProvider); requires ANTHROPIC_API_KEY. */
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

    const toolUse = response.content.find(
      (block: { type: string }) => block.type === "tool_use",
    ) as { input: unknown } | undefined;
    const rawResponse = JSON.stringify(response.content);

    if (!toolUse) {
      throw new Error("AnthropicAIProvider: response contained no tool_use block");
    }

    // Zod validation is the trust boundary here — an invalid tool call
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
```

Modify `packages/ai-provider/src/index.ts` to add `export * from "./anthropic-provider";`.

- [ ] **Step 5: Wire the factory**

```typescript
// apps/worker/src/research/ai-provider.factory.ts — replace the Task 8 stub
import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "@trading-copilot/ai-provider";
import { AnthropicAIProvider, MockAIProvider } from "@trading-copilot/ai-provider";

export function createAIProviderFromEnv(): AIProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new MockAIProvider();
  }
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  return new AnthropicAIProvider(client, model);
}
```

Add `@anthropic-ai/sdk` to `apps/worker/package.json`'s `dependencies`. Run: `pnpm install`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @trading-copilot/ai-provider test && pnpm --filter @trading-copilot/ai-provider typecheck && pnpm --filter @trading-copilot/worker typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/ai-provider apps/worker/src/research/ai-provider.factory.ts apps/worker/package.json
git commit -m "feat(ai-provider): add AnthropicAIProvider (env-gated, tool-call schema validation, token/cost tracking)"
```

---

### Task 11: Dashboard — research list page

**Owner:** frontend-engineer

**Files:**
- Modify: `apps/dashboard/src/lib/api.ts`
- Create: `apps/dashboard/src/app/(dashboard)/research/page.tsx`

**Interfaces:**
- Consumes: `API_BASE_URL` fetch pattern (existing, `lib/api.ts`).
- Produces: `ResearchHypothesis` (dashboard-local type), `listResearchHypotheses(): Promise<ResearchHypothesis[]>`, `generateResearchHypothesis(input): Promise<AgentExecution>` (`lib/api.ts`). `/research` page component.

- [ ] **Step 1: Add API client functions and types**

Before writing this file, open `apps/dashboard/src/app/(dashboard)/setups/page.tsx` (or an equivalent existing list page) to confirm this project's established list-page conventions (loading/error state handling, whether it's a server component fetching directly or a client component, table layout) and match them exactly rather than inventing a new pattern.

```typescript
// apps/dashboard/src/lib/api.ts — add
export type ResearchHypothesisStatus =
  | "PROPOSED"
  | "EXPERIMENT_QUEUED"
  | "IN_PROGRESS"
  | "VALIDATED"
  | "REJECTED"
  | "ABANDONED";
export type HypothesisConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface ResearchHypothesis {
  id: string;
  title: string;
  statement: string;
  rationale: string;
  confidence: HypothesisConfidence;
  status: ResearchHypothesisStatus;
  createdAt: string;
}

export async function listResearchHypotheses(): Promise<ResearchHypothesis[]> {
  const response = await fetch(`${API_BASE_URL}/research/hypotheses`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to list research hypotheses: ${response.status}`);
  }
  return response.json();
}

export async function generateResearchHypothesis(input: {
  strategyId?: string;
  instrumentId?: string;
}): Promise<{ id: string; status: string }> {
  const response = await fetch(`${API_BASE_URL}/research/hypotheses/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to generate a research hypothesis: ${response.status}`);
  }
  return response.json();
}
```

- [ ] **Step 2: Implement the list page**

```tsx
// apps/dashboard/src/app/(dashboard)/research/page.tsx
import Link from "next/link";
import { listResearchHypotheses } from "@/lib/api";

export default async function ResearchPage() {
  const hypotheses = await listResearchHypotheses();

  return (
    <div>
      <h1>Research Hypotheses</h1>
      <p>
        AI-generated, schema-validated hypotheses derived from deterministic journal statistics. See{" "}
        <code>docs/ai-research.md</code> for the pipeline these move through.
      </p>
      {hypotheses.length === 0 ? (
        <p>No hypotheses yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {hypotheses.map((hypothesis) => (
              <tr key={hypothesis.id}>
                <td>
                  <Link href={`/research/${hypothesis.id}`}>{hypothesis.title}</Link>
                </td>
                <td>{hypothesis.status}</td>
                <td>{hypothesis.confidence}</td>
                <td>{new Date(hypothesis.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

(Match this file's exact styling approach — CSS module, Tailwind classes, or plain elements — to whatever `apps/dashboard/src/app/(dashboard)/setups/page.tsx` actually uses; the markup above is illustrative of content/structure, not final styling.)

- [ ] **Step 3: Start the dashboard dev server and verify the page renders against a real API**

Run: `pnpm --filter @trading-copilot/api dev` (in one terminal), `pnpm --filter @trading-copilot/dashboard dev` (in another), then open `http://localhost:3000/research` in a browser and confirm it loads without error (an empty hypotheses table is expected before Task 8/9 have produced any real data end-to-end — that is verified in Task 14).

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @trading-copilot/dashboard typecheck && pnpm --filter @trading-copilot/dashboard lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/api.ts "apps/dashboard/src/app/(dashboard)/research/page.tsx"
git commit -m "feat(dashboard): add research hypothesis list page"
```

---

### Task 12: Dashboard — hypothesis detail page (experiment history, AgentExecution audit)

**Owner:** frontend-engineer

**Files:**
- Modify: `apps/dashboard/src/lib/api.ts`
- Create: `apps/dashboard/src/app/(dashboard)/research/[id]/page.tsx`

**Interfaces:**
- Consumes: `ResearchHypothesis`, `API_BASE_URL` (`lib/api.ts`, Task 11).
- Produces: `ResearchExperiment`, `AgentExecutionSummary` (dashboard-local types), `getResearchHypothesis(id): Promise<{hypothesis, experiments, agentExecution}>` (`lib/api.ts`). `/research/[id]` page component.

- [ ] **Step 1: Add the API client function and types**

```typescript
// apps/dashboard/src/lib/api.ts — add
export type ResearchExperimentStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type ResearchDatasetRole = "RESEARCH" | "VALIDATION" | "FINAL_TEST" | "WALK_FORWARD";

export interface ResearchExperiment {
  id: string;
  hypothesisId: string;
  datasetRole: ResearchDatasetRole;
  datasetWindowStart: string;
  datasetWindowEnd: string;
  backtestId: string | null;
  status: ResearchExperimentStatus;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentExecutionSummary {
  id: string;
  provider: "MOCK" | "ANTHROPIC";
  model: string;
  promptVersion: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: string | null;
  outputRaw: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ResearchHypothesisDetail {
  hypothesis: ResearchHypothesis & { sourceDataSummary: unknown; proposedStrategyDefinition: unknown };
  experiments: ResearchExperiment[];
  agentExecution: AgentExecutionSummary;
}

export async function getResearchHypothesis(id: string): Promise<ResearchHypothesisDetail> {
  const response = await fetch(`${API_BASE_URL}/research/hypotheses/${id}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load research hypothesis ${id}: ${response.status}`);
  }
  return response.json();
}
```

- [ ] **Step 2: Implement the detail page**

```tsx
// apps/dashboard/src/app/(dashboard)/research/[id]/page.tsx
import { notFound } from "next/navigation";
import { getResearchHypothesis } from "@/lib/api";

export default async function ResearchHypothesisDetailPage({ params }: { params: { id: string } }) {
  let detail;
  try {
    detail = await getResearchHypothesis(params.id);
  } catch {
    notFound();
  }
  const { hypothesis, experiments, agentExecution } = detail;

  return (
    <div>
      <h1>{hypothesis.title}</h1>
      <p>Status: {hypothesis.status} · Confidence: {hypothesis.confidence}</p>
      <section>
        <h2>Statement</h2>
        <p>{hypothesis.statement}</p>
      </section>
      <section>
        <h2>Rationale</h2>
        <p>{hypothesis.rationale}</p>
      </section>
      <section>
        <h2>Proposed StrategyDefinition</h2>
        <pre>{JSON.stringify(hypothesis.proposedStrategyDefinition, null, 2)}</pre>
      </section>
      <section>
        <h2>Source Data Summary</h2>
        <pre>{JSON.stringify(hypothesis.sourceDataSummary, null, 2)}</pre>
      </section>
      <section>
        <h2>Experiment History</h2>
        {experiments.length === 0 ? (
          <p>No experiments yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Dataset Role</th>
                <th>Window</th>
                <th>Status</th>
                <th>Backtest</th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((experiment) => (
                <tr key={experiment.id}>
                  <td>{experiment.datasetRole}</td>
                  <td>
                    {new Date(experiment.datasetWindowStart).toLocaleDateString()} –{" "}
                    {new Date(experiment.datasetWindowEnd).toLocaleDateString()}
                  </td>
                  <td>{experiment.status}{experiment.failureReason ? `: ${experiment.failureReason}` : ""}</td>
                  <td>
                    {experiment.backtestId ? (
                      <a href={`/backtests/${experiment.backtestId}`}>view backtest</a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h2>Agent Execution Audit</h2>
        <ul>
          <li>Provider: {agentExecution.provider}</li>
          <li>Model: {agentExecution.model}</li>
          <li>Prompt version: {agentExecution.promptVersion}</li>
          <li>Tokens: {agentExecution.tokensInput ?? "—"} in / {agentExecution.tokensOutput ?? "—"} out</li>
          <li>Cost: {agentExecution.costUsd ? `$${agentExecution.costUsd}` : "—"}</li>
        </ul>
        <details>
          <summary>Raw provider response</summary>
          <pre>{agentExecution.outputRaw ?? "(none)"}</pre>
        </details>
      </section>
    </div>
  );
}
```

(As with Task 11, match final styling to the existing `apps/dashboard/src/app/(dashboard)/setups/[id]/page.tsx` pattern; the markup above is illustrative of content/structure.)

- [ ] **Step 3: Verify against a real API in a browser**

With both dev servers running (per Task 11 Step 3), navigate to `/research/<some-real-hypothesis-id>` (obtained after Task 14's end-to-end verification) and confirm every section renders without a client-side error, including the raw-response `<details>` disclosure.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @trading-copilot/dashboard typecheck && pnpm --filter @trading-copilot/dashboard lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/api.ts "apps/dashboard/src/app/(dashboard)/research/[id]/page.tsx"
git commit -m "feat(dashboard): add research hypothesis detail page — experiment history, AgentExecution audit"
```

---

## Phase C — Integration and review

### Task 13: Integration — env vars, turbo pass-through, manual research:test script, end-to-end mock-mode verification

**Owner:** Primary/orchestrating agent

**Files:**
- Modify: `.env.example`, `turbo.json`
- Create: `apps/worker/scripts/research-test.ts`
- Modify: `apps/worker/package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–12.
- Produces: a manually runnable `research:test` script (mirrors the existing `notification:test` convention) that exercises the full mock-mode pipeline against the real dev database/Redis.

- [ ] **Step 1: Add environment variables**

Modify `.env.example` — add near the existing `NOTIFICATION_*`/`TELEGRAM_*` block:

```
# Milestone 7 — AI research agent. Unset ANTHROPIC_API_KEY = MockAIProvider
# is used automatically everywhere, including this .env.example's defaults.
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5
RESEARCH_DAILY_TOKEN_BUDGET=200000
```

Modify `turbo.json`'s `globalPassThroughEnv` array to add `"ANTHROPIC_API_KEY"`, `"ANTHROPIC_MODEL"`, `"RESEARCH_DAILY_TOKEN_BUDGET"`.

- [ ] **Step 2: Write the manual verification script**

Before writing this file, open `apps/worker/scripts/notification-test.ts` in full and copy its exact structure (how it constructs a Prisma client / repository calls directly against the dev DB, how it prints progress, how it's wired into `package.json`'s scripts).

```typescript
// apps/worker/scripts/research-test.ts
/**
 * Manual, human-run verification of the mock-mode research pipeline end to
 * end against the real dev database (never run in CI/automated tests —
 * see docs/ai-research.md "Manual verification"). Mirrors
 * apps/worker/scripts/notification-test.ts's structure.
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
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
```

Add to `apps/worker/package.json`'s `scripts`: `"research:test": "tsx scripts/research-test.ts"` (match the existing `notification:test` script's exact runner — `tsx`/`ts-node`/other — instead of assuming `tsx`).

- [ ] **Step 3: Run the full quality gates**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS across every package/app. Fix any failure before proceeding — do not defer a red gate to a later task.

- [ ] **Step 4: Run the manual verification script against the real dev stack**

Run: `docker compose up -d` (if not already running), `pnpm --filter @trading-copilot/database exec prisma migrate deploy`, then `pnpm --filter @trading-copilot/worker research:test`
Expected: prints a real `AgentExecution` id and a real `ResearchHypothesis` id backed by rows actually persisted in the dev database; confirm with `psql`/Prisma Studio that both rows exist and `AgentExecution.status = 'SUCCEEDED'`.

- [ ] **Step 5: Commit**

```bash
git add .env.example turbo.json apps/worker/scripts/research-test.ts apps/worker/package.json
git commit -m "chore: wire research-agent env vars, turbo pass-through, and a manual mock-mode verification script"
```

---

### Task 14: research-methodologist review — dataset isolation, overfitting safeguards, guardrail correctness

**Owner:** research-methodologist

**Files:**
- Read-only review of Tasks 1–13's diff (use `superpowers`'s `scripts/review-package` convention: generate a diff against the pre-Milestone-7 `main` and review it in full).

**Interfaces:**
- Consumes: the full merged `milestone-7-work` branch diff.
- Produces: a findings report (BLOCKER/HIGH/MEDIUM/LOW), specifically checking:
  - Does `createResearchExperiment`'s stage-ordering check (Task 5) actually prevent skipping a stage, including the very first `RESEARCH`-stage call (which must NOT require a prior stage)?
  - Does the final-test partial unique index's `WHERE` clause (Task 1) correctly exclude `FAILED` experiments (so a genuine retry after an infra failure isn't permanently blocked) while still blocking a second attempt after a real `COMPLETED` result?
  - Does `assertSampleSizeGuardrails` (Task 4) really require BOTH the calendar-days AND setup-count conditions, never falling back to either alone?
  - Does anything in the `AnthropicAIProvider`/`ResearchAgent`/`AgentExecutionProcessor` chain (Tasks 7-10) let the AI's output influence a P&L/risk number, rather than only ever being read as a hypothesis?
  - Is a `FAILED` `ResearchExperiment`/`AgentExecution` ever deleted, hidden from a list endpoint, or excluded from `getTodayResearchSpend`'s accounting?
  - Does `markPaperCandidate` (Task 9) truly require a human-supplied `confirmedByHuman: true` and real completed `FINAL_TEST`+`WALK_FORWARD` experiments, with no code path that could set `PAPER_CANDIDATE` automatically?

- [ ] **Step 1: Generate the review package**

Run: `.superpowers/scripts/review-package <plan-basename> main milestone-7-work` (adjust to this repo's actual script invocation convention, confirmed from its prior use in the Milestone 6 review cycle)

- [ ] **Step 2: Review and report findings**

Produce a written findings list, each tagged BLOCKER/HIGH/MEDIUM/LOW with the exact file/line and the concrete failure scenario, following this project's established review-report format from the Milestone 6 cycle.

---

### Task 15: journal-analyst review — audit-trail completeness

**Owner:** journal-analyst

**Files:**
- Read-only review of Tasks 1, 8, 9's diff (schema, `AgentExecutionProcessor`, `ResearchService`) plus the actual `JournalEvent` rows produced by Task 13's manual verification run.

**Interfaces:**
- Consumes: the merged branch diff; a live query against the dev database's `JournalEvent` table after Task 13 Step 4 has run.
- Produces: a findings report checking:
  - Does every code path that can create an `AgentExecution`/`ResearchHypothesis`/`ResearchExperiment` also emit the corresponding `JournalEvent` (`AGENT_STARTED`/`AGENT_COMPLETED`/`AGENT_FAILED`/`RESEARCH_HYPOTHESIS_CREATED`/`RESEARCH_EXPERIMENT_CREATED`/`RESEARCH_EXPERIMENT_COMPLETED`) — including the `AgentExecutionProcessor`'s `catch` branch (a thrown error must not skip the `AGENT_FAILED` event)?
  - Is `RESEARCH_HYPOTHESIS_CREATED` actually emitted anywhere (the plan as drafted through Task 9 may have missed wiring this specific event — confirm during review and, if missing, add it to `ResearchService.generateHypothesis`'s enqueue path or `AgentExecutionProcessor`'s success branch, whichever is the correct single source of truth for "a hypothesis now exists")?
  - Are `AgentExecution`/`ResearchHypothesis`/`ResearchExperiment` rows genuinely append-only in every exposed repository function (re-confirm the Task 5 test's assertion that no delete function exists still holds after Tasks 8-10's additions)?

- [ ] **Step 1: Query real JournalEvent rows from Task 13's verification run**

Run a read-only query (via Prisma Studio or `psql`) for `JournalEvent WHERE entityType IN ('AGENT_EXECUTION', 'RESEARCH_HYPOTHESIS', 'RESEARCH_EXPERIMENT')` and cross-check against the expected event sequence.

- [ ] **Step 2: Review and report findings**

If `RESEARCH_HYPOTHESIS_CREATED` is confirmed missing, add exactly one `journalEvents.recordEvent(...)` call at the correct point in `AgentExecutionProcessor`'s success branch (immediately after `createResearchHypothesis`, alongside the existing `AGENT_COMPLETED` event) and re-verify with Task 13 Step 4.

---

### Task 16: system-architect review — module boundaries, dependency direction, financial-calculation isolation

**Owner:** system-architect

**Files:**
- Read-only review of the merged branch diff.

**Interfaces:**
- Consumes: the merged branch diff, `packages/*/package.json` dependency graphs.
- Produces: a findings report checking:
  - `packages/ai-provider` has zero dependency on `packages/database`, `apps/api`, `apps/worker`, or any NestJS/BullMQ package — confirm via its actual `package.json`.
  - No `decimal.js`-typed financial value crosses into `packages/ai-provider` un-stringified (re-verify `ResearchAgent.toJsonSafe`'s serialization actually catches every `Decimal` in a real `ResearchDataSummary`, not just the illustrative test fixture).
  - `packages/backtester`'s `AtrStopTargetParameters` cast (Task 3, Step 7) is the only place a structural narrowing was introduced, and it is honestly documented, not a silent `as any`.
  - `apps/api`'s `ResearchService` and `apps/worker`'s `AgentExecutionProcessor` do not duplicate any persistence logic that belongs in `packages/database/src/repositories/research.ts` (both should call through the repository, never touch `prisma` directly).
  - `STRATEGY_REGISTRY`'s generalization (Task 3) did not silently change `ema-trend-pullback`'s existing behavior — the pre-existing `ema-trend-pullback.test.ts` suite must be unchanged and still green.

- [ ] **Step 1: Review and report findings**

Follow this project's established review-report format from the Milestone 6 cycle; run `pnpm --filter @trading-copilot/backtester test -- ema-trend-pullback` (or the equivalent existing test file name) as part of confirming the last bullet above.

---

### Task 17: quality-reviewer — final correctness review

**Owner:** quality-reviewer

**Files:**
- Read-only review of the entire merged branch; runs the full quality gate suite.

**Interfaces:**
- Consumes: the merged branch.
- Produces: a findings report covering financial-determinism violations, look-ahead-bias risk in `evaluateStrategyDefinition` (re-verify the Task 3 look-ahead test actually exercises every rule type, not just `EMA_CROSS_ABOVE`), TypeScript strictness (`any` usage), test coverage gaps against every item in this plan's "Global Constraints" section, and a final full run of `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

- [ ] **Step 1: Run the full quality gate suite and report any failure**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

- [ ] **Step 2: Review and report findings**

Follow this project's established review-report format from the Milestone 6 cycle.

---

### Task 18: Fix wave — resolve BLOCKER and HIGH findings from Tasks 14–17

**Owner:** Primary/orchestrating agent

**Files:** whatever Tasks 14–17's findings name.

**Interfaces:** none new — this task only touches files already introduced by Tasks 1–13.

- [ ] **Step 1: Triage every finding from Tasks 14–17 into BLOCKER/HIGH (must fix), MEDIUM/LOW (note in docs/implementation-status.md "Known limitations" instead)**

- [ ] **Step 2: Fix every BLOCKER and HIGH finding, one commit per logically-distinct fix**

Follow the exact same discipline as the post-Milestone-6 technical-debt pass: a genuine race/correctness bug gets a real regression test proving the fix, not just a code change.

- [ ] **Step 3: Re-run the full quality gate suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 4: Commit the fix-wave summary**

```bash
git add -A
git commit -m "fix: resolve BLOCKER/HIGH findings from Milestone 7 research-methodologist/journal-analyst/system-architect/quality-reviewer review"
```

---

### Task 19: Documentation

**Owner:** Primary/orchestrating agent

**Files:**
- Create: `docs/ai-research.md`
- Modify: `docs/implementation-status.md`, `docs/roadmap.md`, `docs/research-methodology.md`, `docs/architecture.md`

- [ ] **Step 1: Write `docs/ai-research.md`**

Cover, at minimum: the `AIProvider` abstraction and why `MockAIProvider` is the default; the `ResearchAgent`'s exact input (a `ResearchDataSummary`, never raw candles) and output (a schema-validated `ResearchHypothesisOutput`); why the DSL (`StrategyDefinition`) exists instead of AI-generated code, with its four supported rule types; the `AgentExecution` audit model and prompt-versioning/cost-tracking fields; the dataset-role pipeline (`RESEARCH → VALIDATION → FINAL_TEST → WALK_FORWARD`) and the final-test reuse safeguard's exact mechanism (the partial unique index); the experiment-budget mechanism (`RESEARCH_DAILY_TOKEN_BUDGET`); "What the ResearchAgent can and cannot see" (the `EnrichedJournalTrade.context: null` limitation for non-Setup-backed trades and backtest-sourced trades); how `PAPER_CANDIDATE` is reached (human-gated, never automatic) and what still needs to happen before `PAPER_TRADING`/`APPROVED` (out of scope for this milestone).

- [ ] **Step 2: Update `docs/research-methodology.md`**

Add a subsection after "Strategy lifecycle" documenting the inserted `PAPER_CANDIDATE` status and cross-referencing `docs/ai-research.md` for the dataset-role/final-test-reuse mechanism, without contradicting any existing sentence in the file (re-read the whole file before editing — it is the governing document Task 14's review will check this plan against).

- [ ] **Step 3: Update `docs/implementation-status.md` and `docs/roadmap.md`**

Mark Milestone 7 complete with the same level of detail as the existing Milestone 6 entry (commit references, what was resolved from review, known limitations carried forward from Task 18's MEDIUM/LOW triage). Update the roadmap to reflect that the next milestone is the live Structure/Regime/Critic/Event agent work — explicitly noting it is NOT started, per the kickoff brief's final instruction.

- [ ] **Step 4: Update `docs/architecture.md`**

Add `packages/ai-provider` to the package list and dependency diagram, matching its real (zero-NestJS/zero-database) dependency footprint confirmed by Task 16's review.

- [ ] **Step 5: Commit**

```bash
git add docs/ai-research.md docs/implementation-status.md docs/roadmap.md docs/research-methodology.md docs/architecture.md
git commit -m "docs: document Milestone 7 AI research agent + experiment framework"
```
