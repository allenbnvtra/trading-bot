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
    // defaultJobOptions applies to jobs added from a Queue instance obtained
    // through this registration - this app is where setup-expiration jobs
    // are actually enqueued (tradingview-webhook.processor.ts), so this is
    // the registration that needs a retry policy, not apps/api's. Without
    // this, a transient failure (e.g. a momentary Postgres blip) would mark
    // the InboundWebhookEvent FAILED permanently with no automatic retry,
    // even though both processors already have retry-safe idempotency logic
    // built in (see ALREADY_RESOLVED_STATUSES in tradingview-webhook.processor.ts
    // and the terminal-status check in setup-expiration.processor.ts).
    BullModule.registerQueue({
      name: SETUP_EXPIRATION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
    }),
  ],
  providers: [BacktestRunProcessor, TradingViewWebhookProcessor, SetupExpirationProcessor],
})
export class AppModule {}
