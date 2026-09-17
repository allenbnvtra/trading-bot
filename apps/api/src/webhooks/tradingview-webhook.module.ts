import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { TRADINGVIEW_WEBHOOK_QUEUE } from "@trading-copilot/shared-types";
import { TradingViewWebhookController } from "./tradingview-webhook.controller";
import { TradingViewWebhookService } from "./tradingview-webhook.service";

/**
 * Rate limit is configurable via env (docs/tradingview-security.md
 * "production controls"), generous defaults for local dev: 120 requests per
 * 60 seconds. Registered only in this module (not app-wide) so it only
 * applies where ThrottlerGuard is actually used - POST /webhooks/tradingview.
 */
const rateLimit = process.env.TRADINGVIEW_WEBHOOK_RATE_LIMIT
  ? Number(process.env.TRADINGVIEW_WEBHOOK_RATE_LIMIT)
  : 120;
const rateTtlSeconds = process.env.TRADINGVIEW_WEBHOOK_RATE_TTL_SECONDS
  ? Number(process.env.TRADINGVIEW_WEBHOOK_RATE_TTL_SECONDS)
  : 60;

@Module({
  imports: [
    BullModule.registerQueue({ name: TRADINGVIEW_WEBHOOK_QUEUE }),
    ThrottlerModule.forRoot([
      {
        name: "tradingview-webhook",
        ttl: rateTtlSeconds * 1000,
        limit: rateLimit,
      },
    ]),
  ],
  controllers: [TradingViewWebhookController],
  providers: [TradingViewWebhookService],
})
export class TradingViewWebhookModule {}
