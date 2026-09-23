-- AlterTable
ALTER TABLE "JournalEvent" ADD COLUMN     "sequence" SERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "JournalEvent_correlationId_timestamp_sequence_idx" ON "JournalEvent"("correlationId", "timestamp", "sequence");
