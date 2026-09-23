import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import {
  NOTIFICATION_QUEUE,
  RESEARCH_AGENT_JOB_OPTIONS,
  RESEARCH_AGENT_QUEUE,
  SCREENSHOT_QUEUE,
  SETUP_EXPIRATION_QUEUE,
  TRADINGVIEW_WEBHOOK_JOB_OPTIONS,
  TRADINGVIEW_WEBHOOK_QUEUE,
  WEBHOOK_RECONCILIATION_QUEUE,
} from "@trading-copilot/shared-types";
import { BACKTEST_RUN_QUEUE } from "./backtest-run/backtest-run.constants";
import { BacktestRunProcessor } from "./backtest-run/backtest-run.processor";
import { createRedisConnectionOptions } from "./common/redis-connection";
import { NotificationSendProcessor, notificationProviderProvider } from "./notifications/notification-send.processor";
import { AgentExecutionProcessor, aiProviderProvider } from "./research/agent-execution.processor";
import { BrowserManager } from "./screenshot-generation/browser-manager";
import { ScreenshotGenerationProcessor } from "./screenshot-generation/screenshot-generation.processor";
import { screenshotStorageProvider } from "./screenshot-generation/screenshot-storage.provider";
import { SetupExpirationProcessor } from "./setup-expiration/setup-expiration.processor";
import { TradingViewWebhookProcessor } from "./tradingview-webhook/tradingview-webhook.processor";
import { WebhookReconciliationProcessor } from "./webhook-reconciliation/webhook-reconciliation.processor";

@Module({
  imports: [
    BullModule.forRoot({
      connection: createRedisConnectionOptions(),
    }),
    BullModule.registerQueue({ name: BACKTEST_RUN_QUEUE }),
    // defaultJobOptions is per-Queue-instance, not per-queue-name: this app
    // registers its own Queue instance for TRADINGVIEW_WEBHOOK_QUEUE (the
    // one WebhookReconciliationProcessor's sweep re-enqueues jobs through),
    // distinct from apps/api's producer-side instance
    // (tradingview-webhook.module.ts). Without passing the same shared
    // TRADINGVIEW_WEBHOOK_JOB_OPTIONS here too, every re-enqueue from the
    // reconciliation sweep would silently fall back to BullMQ's bare
    // defaults (1 attempt, no backoff) - the opposite of what the recovery
    // path needs. See that constant's doc comment in
    // packages/shared-types/src/tradingview.ts.
    BullModule.registerQueue({
      name: TRADINGVIEW_WEBHOOK_QUEUE,
      defaultJobOptions: TRADINGVIEW_WEBHOOK_JOB_OPTIONS,
    }),
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
    BullModule.registerQueue({ name: WEBHOOK_RECONCILIATION_QUEUE }),
    // attempts: 1 - deliberately not retried automatically
    // (docs/screenshot-design.md "do not retry indefinitely"). Every
    // failure path in ScreenshotGenerationProcessor already marks the
    // TradeScreenshot row FAILED before rethrowing, so a failed job here
    // never leaves a row silently stuck at GENERATING; a human (or a
    // future manual "retry" action) re-triggers generation instead of an
    // automatic BullMQ retry storm re-launching Chromium repeatedly.
    BullModule.registerQueue({
      name: SCREENSHOT_QUEUE,
      defaultJobOptions: { attempts: 1 },
    }),
    // Unlike SCREENSHOT_QUEUE's deliberate attempts: 1, this queue needs
    // BullMQ's own backoff for TEMPORARY provider failures (a momentary
    // Telegram/network blip) — see NotificationSendProcessor's own doc
    // comment for why PERMANENT failures are never rethrown and so never
    // actually consume these retries.
    BullModule.registerQueue({
      name: NOTIFICATION_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 5_000 },
      },
    }),
    // attempts: 1, matches SCREENSHOT_QUEUE's deliberate policy: an LLM call
    // is neither free nor safe to retry automatically (see
    // RESEARCH_AGENT_JOB_OPTIONS's own doc comment in
    // packages/shared-types/src/research.ts). AgentExecutionProcessor's
    // catch block always marks the AgentExecution row FAILED and records an
    // AGENT_FAILED journal event before rethrowing, so a failed job here
    // never leaves the row silently stuck at RUNNING; a human retries via a
    // fresh POST /research/hypotheses/generate rather than an automatic
    // BullMQ retry storm re-calling the AI provider.
    BullModule.registerQueue({
      name: RESEARCH_AGENT_QUEUE,
      defaultJobOptions: RESEARCH_AGENT_JOB_OPTIONS,
    }),
  ],
  providers: [
    BacktestRunProcessor,
    TradingViewWebhookProcessor,
    SetupExpirationProcessor,
    WebhookReconciliationProcessor,
    BrowserManager,
    screenshotStorageProvider,
    ScreenshotGenerationProcessor,
    notificationProviderProvider,
    NotificationSendProcessor,
    aiProviderProvider,
    AgentExecutionProcessor,
  ],
})
export class AppModule {}
