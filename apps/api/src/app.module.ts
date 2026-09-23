import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AnalyticsModule } from "./analytics/analytics.module";
import { BacktestModule } from "./backtests/backtest.module";
import { createRedisConnectionOptions } from "./common/redis-connection";
import { HealthModule } from "./health/health.module";
import { InstrumentModule } from "./instruments/instrument.module";
import { JournalModule } from "./journal/journal.module";
import { MarketDataModule } from "./market-data/market-data.module";
import { MarketSnapshotModule } from "./market-snapshots/market-snapshot.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { ResearchModule } from "./research/research.module";
import { SetupModule } from "./setups/setup.module";
import { StrategyModule } from "./strategies/strategy.module";
import { TradingViewWebhookModule } from "./webhooks/tradingview-webhook.module";

@Module({
  imports: [
    BullModule.forRoot({
      connection: createRedisConnectionOptions(),
    }),
    HealthModule,
    InstrumentModule,
    MarketDataModule,
    StrategyModule,
    BacktestModule,
    MarketSnapshotModule,
    SetupModule,
    JournalModule,
    AnalyticsModule,
    TradingViewWebhookModule,
    RealtimeModule,
    ResearchModule,
  ],
})
export class AppModule {}
