import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { SETUP_EXPIRATION_QUEUE, TRADINGVIEW_WEBHOOK_QUEUE } from "@trading-copilot/shared-types";
import { BACKTEST_RUN_QUEUE } from "./backtest-run/backtest-run.constants";
import { BacktestRunProcessor } from "./backtest-run/backtest-run.processor";
import { createRedisConnectionOptions } from "./common/redis-connection";
import { SetupExpirationProcessor } from "./setup-expiration/setup-expiration.processor";
import { TradingViewWebhookProcessor } from "./tradingview-webhook/tradingview-webhook.processor";

@Module({
  imports: [
    BullModule.forRoot({
      connection: createRedisConnectionOptions(),
    }),
    BullModule.registerQueue({ name: BACKTEST_RUN_QUEUE }),
    BullModule.registerQueue({ name: TRADINGVIEW_WEBHOOK_QUEUE }),
    BullModule.registerQueue({ name: SETUP_EXPIRATION_QUEUE }),
  ],
  providers: [BacktestRunProcessor, TradingViewWebhookProcessor, SetupExpirationProcessor],
})
export class AppModule {}
