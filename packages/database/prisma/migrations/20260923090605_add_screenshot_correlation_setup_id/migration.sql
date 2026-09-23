-- AlterEnum
ALTER TYPE "JournalEventType" ADD VALUE 'SCREENSHOT_RETRIED';

-- AlterTable
ALTER TABLE "TradeScreenshot" ADD COLUMN     "correlationSetupId" TEXT;
