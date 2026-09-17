-- CreateEnum
CREATE TYPE "SetupStatus" AS ENUM ('WATCH', 'PREPARE', 'READY', 'REJECTED', 'INVALIDATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SetupSource" AS ENUM ('BACKTEST', 'MANUAL_TEST', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('BACKTEST', 'PAPER', 'MANUAL_LIVE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JournalTradeStatus" AS ENUM ('PLANNED', 'OPEN', 'CLOSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TradeSource" AS ENUM ('BACKTEST_TRADE', 'JOURNAL_TRADE');

-- CreateEnum
CREATE TYPE "PostTradeOutcome" AS ENUM ('WIN', 'LOSS', 'BREAKEVEN');

-- CreateEnum
CREATE TYPE "LossCategory" AS ENUM ('TREND_MISALIGNMENT', 'RESISTANCE_TOO_CLOSE', 'SUPPORT_TOO_CLOSE', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'LOW_VOLUME', 'BREAKOUT_FAILURE', 'FALSE_BREAKOUT', 'EARLY_ENTRY', 'LATE_ENTRY', 'NEWS_EVENT', 'BAD_RISK_REWARD', 'MARKET_REGIME_MISMATCH', 'SESSION_TIMING', 'GAP_EVENT', 'STOP_TOO_TIGHT', 'STOP_TOO_WIDE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "JournalEventType" AS ENUM ('SETUP_CREATED', 'STRATEGY_EVALUATED', 'RISK_CALCULATED', 'SETUP_APPROVED', 'SETUP_REJECTED', 'SETUP_INVALIDATED', 'SETUP_EXPIRED', 'TRADE_READY', 'TRADE_EXECUTED', 'TRADE_SKIPPED', 'TRADE_CLOSED', 'POST_TRADE_ANALYSIS_CREATED', 'STRATEGY_VERSION_PROPOSED');

-- CreateEnum
CREATE TYPE "JournalEntityType" AS ENUM ('SETUP', 'JOURNAL_TRADE', 'RISK_CALCULATION', 'MARKET_SNAPSHOT', 'BACKTEST', 'BACKTEST_TRADE', 'STRATEGY_VERSION', 'POST_TRADE_ANALYSIS');

-- CreateEnum
CREATE TYPE "ScreenshotType" AS ENUM ('PRE_TRADE', 'POST_TRADE');

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "timeframe" TEXT NOT NULL,
    "windowCandleCount" INTEGER,
    "windowStartTimestamp" TIMESTAMP(3),
    "windowEndTimestamp" TIMESTAMP(3),
    "trend1m" TEXT,
    "trend5m" TEXT,
    "trend15m" TEXT,
    "trend1h" TEXT,
    "trend4h" TEXT,
    "trend1d" TEXT,
    "atr" DECIMAL(18,8),
    "atrPercentile" DECIMAL(9,6),
    "volume" DECIMAL(18,8),
    "volumePercentile" DECIMAL(9,6),
    "vwap" DECIMAL(18,8),
    "vwapDistance" DECIMAL(18,8),
    "nearestSupport" DECIMAL(18,8),
    "distanceToSupport" DECIMAL(18,8),
    "nearestResistance" DECIMAL(18,8),
    "distanceToResistance" DECIMAL(18,8),
    "session" TEXT,
    "timeOfDay" TEXT,
    "dayOfWeek" TEXT,
    "marketRegime" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setup" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "marketSnapshotId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "source" "SetupSource" NOT NULL,
    "plannedEntry" DECIMAL(18,8) NOT NULL,
    "plannedStop" DECIMAL(18,8) NOT NULL,
    "plannedTarget1" DECIMAL(18,8) NOT NULL,
    "plannedTarget2" DECIMAL(18,8),
    "status" "SetupStatus" NOT NULL DEFAULT 'WATCH',
    "decisionSummary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Setup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskCalculation" (
    "id" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "accountEquity" DECIMAL(18,8) NOT NULL,
    "riskPercentage" DECIMAL(9,6) NOT NULL,
    "riskBudget" DECIMAL(18,8) NOT NULL,
    "entryPrice" DECIMAL(18,8) NOT NULL,
    "stopPrice" DECIMAL(18,8) NOT NULL,
    "stopDistancePoints" DECIMAL(18,8) NOT NULL,
    "stopDistanceTicks" DECIMAL(18,8) NOT NULL,
    "pointValue" DECIMAL(18,8) NOT NULL,
    "tickValue" DECIMAL(18,8) NOT NULL,
    "estimatedCommission" DECIMAL(18,8) NOT NULL,
    "estimatedSlippage" DECIMAL(18,8) NOT NULL,
    "riskPerUnit" DECIMAL(18,8) NOT NULL,
    "calculatedQuantity" INTEGER NOT NULL,
    "estimatedTotalRisk" DECIMAL(18,8) NOT NULL,
    "riskReward" DECIMAL(18,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalTrade" (
    "id" TEXT NOT NULL,
    "setupId" TEXT,
    "instrumentId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "plannedEntry" DECIMAL(18,8) NOT NULL,
    "plannedStop" DECIMAL(18,8) NOT NULL,
    "plannedTarget1" DECIMAL(18,8),
    "plannedTarget2" DECIMAL(18,8),
    "actualEntry" DECIMAL(18,8),
    "actualExit" DECIMAL(18,8),
    "entryTimestamp" TIMESTAMP(3),
    "exitTimestamp" TIMESTAMP(3),
    "quantity" INTEGER,
    "plannedRisk" DECIMAL(18,8),
    "estimatedFees" DECIMAL(18,8),
    "actualFees" DECIMAL(18,8),
    "estimatedSlippage" DECIMAL(18,8),
    "actualSlippage" DECIMAL(18,8),
    "grossPnl" DECIMAL(18,8),
    "netPnl" DECIMAL(18,8),
    "rMultiple" DECIMAL(18,8),
    "mfe" DECIMAL(18,8),
    "mae" DECIMAL(18,8),
    "executionMode" "ExecutionMode" NOT NULL,
    "status" "JournalTradeStatus" NOT NULL DEFAULT 'PLANNED',
    "entryNotes" TEXT,
    "exitNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEvent" (
    "id" TEXT NOT NULL,
    "eventType" "JournalEventType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entityType" "JournalEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "correlationId" TEXT,
    "instrumentId" TEXT,
    "strategyId" TEXT,
    "strategyVersionId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "JournalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostTradeAnalysis" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "tradeSource" "TradeSource" NOT NULL,
    "outcome" "PostTradeOutcome" NOT NULL,
    "primaryCause" "LossCategory",
    "contributingFactors" "LossCategory"[],
    "confidence" DECIMAL(9,6),
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "researchHypotheses" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostTradeAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeScreenshot" (
    "id" TEXT NOT NULL,
    "setupId" TEXT,
    "tradeId" TEXT,
    "tradeSource" "TradeSource",
    "type" "ScreenshotType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "marketSnapshotId" TEXT,
    "chartConfigVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeScreenshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketSnapshot_instrumentId_timeframe_timestamp_idx" ON "MarketSnapshot"("instrumentId", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "Setup_instrumentId_status_idx" ON "Setup"("instrumentId", "status");

-- CreateIndex
CREATE INDEX "Setup_strategyVersionId_idx" ON "Setup"("strategyVersionId");

-- CreateIndex
CREATE INDEX "Setup_status_idx" ON "Setup"("status");

-- CreateIndex
CREATE INDEX "RiskCalculation_setupId_createdAt_idx" ON "RiskCalculation"("setupId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalTrade_instrumentId_idx" ON "JournalTrade"("instrumentId");

-- CreateIndex
CREATE INDEX "JournalTrade_strategyVersionId_idx" ON "JournalTrade"("strategyVersionId");

-- CreateIndex
CREATE INDEX "JournalTrade_executionMode_status_idx" ON "JournalTrade"("executionMode", "status");

-- CreateIndex
CREATE INDEX "JournalEvent_entityType_entityId_idx" ON "JournalEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "JournalEvent_correlationId_idx" ON "JournalEvent"("correlationId");

-- CreateIndex
CREATE INDEX "JournalEvent_timestamp_idx" ON "JournalEvent"("timestamp");

-- CreateIndex
CREATE INDEX "JournalEvent_instrumentId_idx" ON "JournalEvent"("instrumentId");

-- CreateIndex
CREATE INDEX "JournalEvent_strategyId_strategyVersionId_idx" ON "JournalEvent"("strategyId", "strategyVersionId");

-- CreateIndex
CREATE INDEX "PostTradeAnalysis_tradeId_tradeSource_idx" ON "PostTradeAnalysis"("tradeId", "tradeSource");

-- CreateIndex
CREATE INDEX "TradeScreenshot_tradeId_tradeSource_idx" ON "TradeScreenshot"("tradeId", "tradeSource");

-- CreateIndex
CREATE INDEX "TradeScreenshot_setupId_idx" ON "TradeScreenshot"("setupId");

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setup" ADD CONSTRAINT "Setup_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setup" ADD CONSTRAINT "Setup_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setup" ADD CONSTRAINT "Setup_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setup" ADD CONSTRAINT "Setup_marketSnapshotId_fkey" FOREIGN KEY ("marketSnapshotId") REFERENCES "MarketSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskCalculation" ADD CONSTRAINT "RiskCalculation_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalTrade" ADD CONSTRAINT "JournalTrade_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalTrade" ADD CONSTRAINT "JournalTrade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalTrade" ADD CONSTRAINT "JournalTrade_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalTrade" ADD CONSTRAINT "JournalTrade_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeScreenshot" ADD CONSTRAINT "TradeScreenshot_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "Setup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
