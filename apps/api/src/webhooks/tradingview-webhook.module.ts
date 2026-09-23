import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { TRADINGVIEW_WEBHOOK_JOB_OPTIONS, TRADINGVIEW_WEBHOOK_QUEUE } from "@trading-copilot/shared-types";
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
    // defaultJobOptions applies to jobs added from a Queue instance obtained
    // through this registration. Both apps/api (the original ingest enqueue
    // in tradingview-webhook.service.ts) and apps/worker (the reconciliation
    // sweep's re-enqueue in webhook-reconciliation.processor.ts) register
    // their own Queue instance for this same queue name, so the shared
    // TRADINGVIEW_WEBHOOK_JOB_OPTIONS constant is passed at both registration
    // sites - see that constant's doc comment in
    // packages/shared-types/src/tradingview.ts for why a single registration
    // isn't enough. Without this, a transient failure marks the
    // InboundWebhookEvent FAILED permanently with no automatic retry, even
    // though the worker's own processor already has retry-safe idempotency
    // logic built in (see ALREADY_RESOLVED_STATUSES in
    // tradingview-webhook.processor.ts).
    BullModule.registerQueue({
      name: TRADINGVIEW_WEBHOOK_QUEUE,
      defaultJobOptions: TRADINGVIEW_WEBHOOK_JOB_OPTIONS,
    }),
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
