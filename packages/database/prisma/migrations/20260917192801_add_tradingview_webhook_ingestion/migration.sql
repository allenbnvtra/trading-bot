-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('TRADINGVIEW');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'DUPLICATE', 'REJECTED', 'FAILED', 'UNSUPPORTED');

-- AlterEnum
ALTER TYPE "JournalEntityType" ADD VALUE 'INBOUND_WEBHOOK_EVENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalEventType" ADD VALUE 'WEBHOOK_RECEIVED';
ALTER TYPE "JournalEventType" ADD VALUE 'WEBHOOK_NORMALIZED';
ALTER TYPE "JournalEventType" ADD VALUE 'SIGNAL_ACCEPTED';
ALTER TYPE "JournalEventType" ADD VALUE 'WEBHOOK_DUPLICATE_DETECTED';
ALTER TYPE "JournalEventType" ADD VALUE 'WEBHOOK_REJECTED';
ALTER TYPE "JournalEventType" ADD VALUE 'WEBHOOK_PROCESSING_FAILED';

-- AlterEnum
ALTER TYPE "SetupSource" ADD VALUE 'TRADINGVIEW';

-- AlterTable
ALTER TABLE "Setup" ALTER COLUMN "plannedStop" DROP NOT NULL,
ALTER COLUMN "plannedTarget1" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TradingViewInstrumentMapping" (
    "id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingViewInstrumentMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schemaVersion" INTEGER NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB,
    "fingerprint" TEXT NOT NULL,
    "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processingStartedAt" TIMESTAMP(3),
    "processingCompletedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "setupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradingViewInstrumentMapping_exchange_symbol_key" ON "TradingViewInstrumentMapping"("exchange", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhookEvent_fingerprint_key" ON "InboundWebhookEvent"("fingerprint");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_provider_receivedAt_idx" ON "InboundWebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_processingStatus_idx" ON "InboundWebhookEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_setupId_idx" ON "InboundWebhookEvent"("setupId");

-- AddForeignKey
ALTER TABLE "TradingViewInstrumentMapping" ADD CONSTRAINT "TradingViewInstrumentMapping_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundWebhookEvent" ADD CONSTRAINT "InboundWebhookEvent_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
