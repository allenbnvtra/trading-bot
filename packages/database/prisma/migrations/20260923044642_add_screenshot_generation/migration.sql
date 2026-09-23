/*
  Warnings:

  - A unique constraint covering the columns `[setupId,type,chartConfigVersion]` on the table `TradeScreenshot` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tradeId,tradeSource,type,chartConfigVersion]` on the table `TradeScreenshot` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `TradeScreenshot` table without a default value. This is not possible if the table is not empty.
  - Made the column `chartConfigVersion` on table `TradeScreenshot` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "ScreenshotStatus" AS ENUM ('REQUESTED', 'GENERATING', 'READY', 'FAILED');

-- AlterEnum
ALTER TYPE "JournalEntityType" ADD VALUE 'TRADE_SCREENSHOT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalEventType" ADD VALUE 'SCREENSHOT_REQUESTED';
ALTER TYPE "JournalEventType" ADD VALUE 'SCREENSHOT_GENERATION_STARTED';
ALTER TYPE "JournalEventType" ADD VALUE 'SCREENSHOT_CREATED';
ALTER TYPE "JournalEventType" ADD VALUE 'SCREENSHOT_FAILED';

-- AlterTable
ALTER TABLE "TradeScreenshot" ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureMessage" TEXT,
ADD COLUMN     "renderedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ScreenshotStatus" NOT NULL DEFAULT 'REQUESTED',
ADD COLUMN     "storageProvider" TEXT NOT NULL DEFAULT 'LOCAL_DISK',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "storageKey" DROP NOT NULL,
ALTER COLUMN "mimeType" DROP NOT NULL,
ALTER COLUMN "chartConfigVersion" SET NOT NULL;

-- CreateIndex
CREATE INDEX "TradeScreenshot_status_idx" ON "TradeScreenshot"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TradeScreenshot_setupId_type_chartConfigVersion_key" ON "TradeScreenshot"("setupId", "type", "chartConfigVersion");

-- CreateIndex
CREATE UNIQUE INDEX "TradeScreenshot_tradeId_tradeSource_type_chartConfigVersion_key" ON "TradeScreenshot"("tradeId", "tradeSource", "type", "chartConfigVersion");
