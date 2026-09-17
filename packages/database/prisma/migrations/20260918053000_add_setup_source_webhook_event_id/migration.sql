-- AlterTable
ALTER TABLE "Setup" ADD COLUMN     "sourceWebhookEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Setup_sourceWebhookEventId_key" ON "Setup"("sourceWebhookEventId");
