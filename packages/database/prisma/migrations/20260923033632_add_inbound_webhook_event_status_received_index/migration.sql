-- CreateIndex
CREATE INDEX "InboundWebhookEvent_processingStatus_receivedAt_idx" ON "InboundWebhookEvent"("processingStatus", "receivedAt");
