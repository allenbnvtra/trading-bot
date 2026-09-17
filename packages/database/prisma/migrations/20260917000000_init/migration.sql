-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('FUTURES', 'FOREX', 'CRYPTO', 'STOCK');

-- CreateEnum
CREATE TYPE "StrategyVersionStatus" AS ENUM ('DISCOVERED', 'BACKTESTING', 'VALIDATION', 'OUT_OF_SAMPLE', 'WALK_FORWARD', 'PAPER_TRADING', 'APPROVED', 'PAUSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "TradeExitReason" AS ENUM ('STOP', 'TARGET', 'SAME_CANDLE_STOP_AND_TARGET', 'END_OF_DATA');

-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "exchange" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "tickSize" DECIMAL(18,8) NOT NULL,
    "tickValue" DECIMAL(18,8) NOT NULL,
    "pointValue" DECIMAL(18,8) NOT NULL,
    "commissionPerContract" DECIMAL(18,8) NOT NULL,
    "timezone" TEXT NOT NULL,
    "sessionConfiguration" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(18,8) NOT NULL,
    "high" DECIMAL(18,8) NOT NULL,
    "low" DECIMAL(18,8) NOT NULL,
    "close" DECIMAL(18,8) NOT NULL,
    "volume" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "status" "StrategyVersionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backtest" (
    "id" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "BacktestStatus" NOT NULL DEFAULT 'QUEUED',
    "assumptions" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Backtest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestTrade" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "signalTimestamp" TIMESTAMP(3) NOT NULL,
    "entryTimestamp" TIMESTAMP(3) NOT NULL,
    "entryPrice" DECIMAL(18,8) NOT NULL,
    "stopPrice" DECIMAL(18,8) NOT NULL,
    "targetPrice" DECIMAL(18,8) NOT NULL,
    "exitTimestamp" TIMESTAMP(3) NOT NULL,
    "exitPrice" DECIMAL(18,8) NOT NULL,
    "entryReason" TEXT NOT NULL,
    "exitReason" "TradeExitReason" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "grossPnl" DECIMAL(18,8) NOT NULL,
    "fees" DECIMAL(18,8) NOT NULL,
    "netPnl" DECIMAL(18,8) NOT NULL,
    "riskAmount" DECIMAL(18,8) NOT NULL,
    "rMultiple" DECIMAL(18,8) NOT NULL,
    "maximumFavorableExcursion" DECIMAL(18,8) NOT NULL,
    "maximumAdverseExcursion" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "BacktestTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestMetrics" (
    "id" TEXT NOT NULL,
    "backtestId" TEXT NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "winningTrades" INTEGER NOT NULL,
    "losingTrades" INTEGER NOT NULL,
    "winRate" DECIMAL(9,6) NOT NULL,
    "grossProfit" DECIMAL(18,8) NOT NULL,
    "grossLoss" DECIMAL(18,8) NOT NULL,
    "netProfit" DECIMAL(18,8) NOT NULL,
    "profitFactor" DECIMAL(18,8),
    "averageTrade" DECIMAL(18,8) NOT NULL,
    "averageR" DECIMAL(18,8) NOT NULL,
    "largestWin" DECIMAL(18,8) NOT NULL,
    "largestLoss" DECIMAL(18,8) NOT NULL,
    "averageWin" DECIMAL(18,8) NOT NULL,
    "averageLoss" DECIMAL(18,8) NOT NULL,
    "maxDrawdown" DECIMAL(18,8) NOT NULL,
    "maxDrawdownPercent" DECIMAL(18,8) NOT NULL,
    "expectancy" DECIMAL(18,8) NOT NULL,
    "maximumConsecutiveWins" INTEGER NOT NULL,
    "maximumConsecutiveLosses" INTEGER NOT NULL,

    CONSTRAINT "BacktestMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_symbol_exchange_key" ON "Instrument"("symbol", "exchange");

-- CreateIndex
CREATE INDEX "Candle_instrumentId_timeframe_timestamp_idx" ON "Candle"("instrumentId", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_instrumentId_timeframe_timestamp_key" ON "Candle"("instrumentId", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_key_key" ON "Strategy"("key");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_strategyId_version_key" ON "StrategyVersion"("strategyId", "version");

-- CreateIndex
CREATE INDEX "BacktestTrade_backtestId_idx" ON "BacktestTrade"("backtestId");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestMetrics_backtestId_key" ON "BacktestMetrics"("backtestId");

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backtest" ADD CONSTRAINT "Backtest_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestTrade" ADD CONSTRAINT "BacktestTrade_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacktestMetrics" ADD CONSTRAINT "BacktestMetrics_backtestId_fkey" FOREIGN KEY ("backtestId") REFERENCES "Backtest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

