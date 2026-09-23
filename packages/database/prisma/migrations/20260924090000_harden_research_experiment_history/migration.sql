-- Milestone 7 fix wave 1: harden ResearchExperiment history.
--
-- Written by hand in the exact shape `prisma migrate dev --create-only`
-- produces for the schema.prisma changes (FK onDelete + enum value), plus
-- the hand-edited partial-index change below, which Prisma's schema DSL
-- cannot express (same convention as
-- 20260923144150_add_journal_trade_active_decision_unique_index and
-- 20260923153300_add_research_agent_framework).

-- AlterEnum
ALTER TYPE "JournalEventType" ADD VALUE 'RESEARCH_EXPERIMENT_FAILED';

-- DropForeignKey
ALTER TABLE "ResearchExperiment" DROP CONSTRAINT "ResearchExperiment_backtestId_fkey";

-- DropForeignKey
ALTER TABLE "ResearchExperiment" DROP CONSTRAINT "ResearchExperiment_hypothesisId_fkey";

-- AddForeignKey
-- RESTRICT (was CASCADE): deleting a hypothesis must never silently erase
-- its experiment history, FAILED rows included.
ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "ResearchHypothesis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT (was SET NULL): deleting a backtest must never silently detach
-- an experiment from the evidence it was judged on.
ALTER TABLE "ResearchExperiment" ADD CONSTRAINT "ResearchExperiment_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Final-test reuse safeguard, widened from an explicit allow-list
-- (status IN ('QUEUED', 'RUNNING', 'COMPLETED')) to "anything but FAILED",
-- so a status value added later counts as "spent" by default. Behavior is
-- identical for today's four statuses. The old index is renamed out of the
-- way first and dropped only after its replacement exists, so there is no
-- window in which the safeguard is absent. Do not replace this with a
-- plain unique constraint (see ResearchExperiment's doc comment in
-- schema.prisma).
ALTER INDEX "ResearchExperiment_hypothesis_final_test_key" RENAME TO "ResearchExperiment_hypothesis_final_test_key_old";

CREATE UNIQUE INDEX "ResearchExperiment_hypothesis_final_test_key"
  ON "ResearchExperiment" ("hypothesisId")
  WHERE "datasetRole" = 'FINAL_TEST' AND "status" <> 'FAILED';

DROP INDEX "ResearchExperiment_hypothesis_final_test_key_old";
