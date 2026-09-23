-- DropIndex
DROP INDEX "TradeScreenshot_status_idx";

-- CreateIndex
CREATE INDEX "TradeScreenshot_status_renderedAt_idx" ON "TradeScreenshot"("status", "renderedAt");

-- CreateIndex
CREATE INDEX "TradeScreenshot_status_updatedAt_idx" ON "TradeScreenshot"("status", "updatedAt");
