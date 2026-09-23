-- CreateEnum
CREATE TYPE "HypothesisConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ResearchHypothesisStatus" AS ENUM ('PROPOSED', 'EXPERIMENT_QUEUED', 'IN_PROGRESS', 'VALIDATED', 'REJECTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ResearchExperimentStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ResearchDatasetRole" AS ENUM ('RESEARCH', 'VALIDATION', 'FINAL_TEST', 'WALK_FORWARD');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('RESEARCH');

-- CreateEnum
CREATE TYPE "AIProviderType" AS ENUM ('MOCK', 'ANTHROPIC');

-- CreateEnum
CREATE TYPE "AgentExecutionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalEntityType" ADD VALUE 'AGENT_EXECUTION';
ALTER TYPE "JournalEntityType" ADD VALUE 'RESEARCH_HYPOTHESIS';
ALTER TYPE "JournalEntityType" ADD VALUE 'RESEARCH_EXPERIMENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalEventType" ADD VALUE 'AGENT_STARTED';
ALTER TYPE "JournalEventType" ADD VALUE 'AGENT_COMPLETED';
ALTER TYPE "JournalEventType" ADD VALUE 'AGENT_FAILED';
ALTER TYPE "JournalEventType" ADD VALUE 'RESEARCH_HYPOTHESIS_CREATED';
ALTER TYPE "JournalEventType" ADD VALUE 'RESEARCH_EXPERIMENT_CREATED';
ALTER TYPE "JournalEventType" ADD VALUE 'RESEARCH_EXPERIMENT_COMPLETED';
ALTER TYPE "JournalEventType" ADD VALUE 'STRATEGY_VERSION_STATUS_CHANGED';

-- AlterEnum
ALTER TYPE "StrategyVersionStatus" ADD VALUE 'PAPER_CANDIDATE';

-- AlterTable
ALTER TABLE "StrategyVersion" ADD COLUMN     "sourceHypothesisId" TEXT;

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "agentType" "AgentType" NOT NULL DEFAULT 'RESEARCH',
    "provider" "AIProviderType" NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputSummary" JSONB NOT NULL,
    "outputRaw" TEXT,
    "outputParsed" JSONB,
    "status" "AgentExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "errorMessage" TEXT,
    "tokensInput" INTEGER,
    "tokensOutput" INTEGER,
    "costUsd" DECIMAL(10,4),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchHypothesis" (
    "id" TEXT NOT NULL,
    "agentExecutionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" "HypothesisConfidence" NOT NULL,
    "sourceDataSummary" JSONB NOT NULL,
    "proposedStrategyDefinition" JSONB NOT NULL,
    "status" "ResearchHypothesisStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchHypothesis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchExperiment" (
    "id" TEXT NOT NULL,
    "hypothesisId" TEXT NOT NULL,
    "datasetRole" "ResearchDatasetRole" NOT NULL,
    "datasetWindowStart" TIMESTAMP(3) NOT NULL,
    "datasetWindowEnd" TIMESTAMP(3) NOT NULL,
    "backtestId" TEXT,
    "status" "ResearchExperimentStatus" NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentExecution_status_idx" ON "AgentExecution"("status");

-- CreateIndex
CREATE INDEX "AgentExecution_startedAt_idx" ON "AgentExecution"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchHypothesis_agentExecutionId_key" ON "ResearchHypothesis"("agentExecutionId");

-- CreateIndex
CREATE INDEX "ResearchHypothesis_status_idx" ON "ResearchHypothesis"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchExperiment_backtestId_key" ON "ResearchExperiment"("backtestId");

-- CreateIndex
CREATE INDEX "ResearchExperiment_hypothesisId_idx" ON "ResearchExperiment"("hypothesisId");

-- CreateIndex
CREATE INDEX "ResearchExperiment_status_idx" ON "ResearchExperiment"("status");

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_sourceHypothesisId_fkey" FOREIGN KEY ("sourceHypothesisId") REFERENCES "ResearchHypothesis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchHypothesis" ADD CONSTRAINT "ResearchHypothesis_agentExecutionId_fkey" FOREIGN KEY ("agentExecutionId") REFERENCES "AgentExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ResearchHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Final-test reuse safeguard: at most one non-FAILED FINAL_TEST experiment
-- per hypothesis. See ResearchExperiment's doc comment in schema.prisma —
-- do not replace this with a plain unique constraint.
CREATE UNIQUE INDEX "ResearchExperiment_hypothesis_final_test_key"
  ON "ResearchExperiment" ("hypothesisId")
  WHERE "datasetRole" = 'FINAL_TEST' AND "status" IN ('QUEUED', 'RUNNING', 'COMPLETED');
