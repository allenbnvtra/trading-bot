-- CreateEnum
CREATE TYPE "NotificationProviderType" AS ENUM ('TELEGRAM', 'CONSOLE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SETUP_PREPARE', 'SETUP_READY', 'SETUP_INVALIDATED', 'SETUP_EXPIRED', 'SETUP_REJECTED');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('MISSED_ALERT', 'PRICE_MOVED', 'MANUAL_DISAGREEMENT', 'RISK_TOO_HIGH', 'BUSY', 'SETUP_NO_LONGER_VALID', 'OTHER');

-- AlterEnum
ALTER TYPE "JournalEntityType" ADD VALUE 'NOTIFICATION_DELIVERY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalEventType" ADD VALUE 'NOTIFICATION_QUEUED';
ALTER TYPE "JournalEventType" ADD VALUE 'NOTIFICATION_SENDING';
ALTER TYPE "JournalEventType" ADD VALUE 'NOTIFICATION_SENT';
ALTER TYPE "JournalEventType" ADD VALUE 'NOTIFICATION_RETRYING';
ALTER TYPE "JournalEventType" ADD VALUE 'NOTIFICATION_FAILED';

-- AlterTable
ALTER TABLE "JournalTrade" ADD COLUMN     "outcome" "PostTradeOutcome",
ADD COLUMN     "skipReason" "SkipReason";

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "setupId" TEXT,
    "tradeId" TEXT,
    "tradeSource" "TradeSource",
    "provider" "NotificationProviderType" NOT NULL,
    "notificationType" "NotificationType" NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendingAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "externalMessageId" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationDelivery_setupId_idx" ON "NotificationDelivery"("setupId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_updatedAt_idx" ON "NotificationDelivery"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_sentAt_idx" ON "NotificationDelivery"("status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_setupId_notificationType_templateVersi_key" ON "NotificationDelivery"("setupId", "notificationType", "templateVersion");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
