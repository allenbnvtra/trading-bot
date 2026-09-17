import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { BACKTEST_RUN_QUEUE } from "./backtest-run/backtest-run.constants";
import { BacktestRunProcessor } from "./backtest-run/backtest-run.processor";
import { createRedisConnectionOptions } from "./common/redis-connection";

@Module({
  imports: [
    BullModule.forRoot({
      connection: createRedisConnectionOptions(),
    }),
    BullModule.registerQueue({ name: BACKTEST_RUN_QUEUE }),
  ],
  providers: [BacktestRunProcessor],
})
export class AppModule {}
