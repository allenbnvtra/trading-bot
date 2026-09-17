import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { BacktestModule } from "./backtests/backtest.module";
import { createRedisConnectionOptions } from "./common/redis-connection";
import { HealthModule } from "./health/health.module";
import { InstrumentModule } from "./instruments/instrument.module";
import { MarketDataModule } from "./market-data/market-data.module";
import { StrategyModule } from "./strategies/strategy.module";

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
  ],
})
export class AppModule {}
