import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type Provider } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS,
  NOTIFICATION_SCREENSHOT_WAIT_MS,
  type SendNotificationJobPayload,
  type SetupStatus,
} from "@trading-copilot/shared-types";
import {
  instrumentsRepository,
  marketSnapshotsRepository,
  notificationDeliveriesRepository,
  riskCalculationsRepository,
  setupsRepository,
  strategiesRepository,
  tradeScreenshotsRepository,
} from "@trading-copilot/database";
import type { NotificationDelivery, Setup, TradeScreenshot } from "@trading-copilot/trading-domain";
import type { ScreenshotStorage } from "@trading-copilot/screenshot-storage";
import { SCREENSHOT_STORAGE_TOKEN } from "../screenshot-generation/screenshot-storage.provider";
import { createNotificationProvider } from "./notification-provider.factory";
import { NotificationProviderError, type NotificationProvider } from "./notification-provider";
import {
  formatReadyTradeCard,
  formatSetupStatusNotice,
  type SetupStatusNoticeNotificationType,
} from "./templates/ready-trade-card";

/**
 * No existing precedent in this codebase for a non-class NestJS injection
 * token other than SCREENSHOT_STORAGE_TOKEN (see
 * screenshot-storage.provider.ts's own doc comment) — NotificationProvider
 * has the same problem (an interface has no runtime value to use as a
 * token), so this follows the same plain-string-token pattern. Kept here
 * (rather than a separate provider file) since this processor is the only
 * consumer and app.module.ts is the only registration site — Task 7's file
 * list is deliberately just these two files.
 */
export const NOTIFICATION_PROVIDER_TOKEN = "NOTIFICATION_PROVIDER";

export const notificationProviderProvider: Provider = {
  provide: NOTIFICATION_PROVIDER_TOKEN,
  useFactory: (): NotificationProvider => createNotificationProvider(),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown by formatMessage when a Setup's referenced context (Instrument,
 * Strategy, StrategyVersion, or MarketSnapshot) no longer resolves. Unlike
 * NotificationProviderError (notification-provider.ts), this is not about
 * the send transport - it is a dangling-foreign-key condition on the
 * Setup itself, and it is deterministic: it will fail identically on every
 * one of BullMQ's configured attempts, since nothing about retrying
 * changes what rows exist in Postgres. Kept in this file (rather than
 * notification-provider.ts) because it is specific to this processor's own
 * Setup-context lookups, not to any NotificationProvider implementation.
 * The processor's catch block routes this to markNotificationFailed
 * (PERMANENT), the same as a PERMANENT NotificationProviderError - see
 * that branch's comment for why retrying would be pointless here too.
 */
export class SetupContextNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupContextNotFoundError";
  }
}

/**
 * The single source of truth for a status-notice's displayed SetupStatus:
 * derived from the NotificationDelivery row's own (immutable, set-at-request-time)
 * notificationType, never from a fresh read of the Setup's *current* status.
 * A status-notice job can still be SENDING after the Setup has moved on to a
 * later status (e.g. a PREPARE notice processed after the Setup already
 * reached REJECTED) — re-reading the live status here would produce a
 * message whose emoji/heading (keyed off notificationType) disagreed with
 * its own status field. See Task 6 review note carried into this task's
 * brief.
 */
const NOTIFICATION_TYPE_TO_SETUP_STATUS: Record<SetupStatusNoticeNotificationType, SetupStatus> = {
  SETUP_PREPARE: "PREPARE",
  SETUP_INVALIDATED: "INVALIDATED",
  SETUP_EXPIRED: "EXPIRED",
  SETUP_REJECTED: "REJECTED",
};

/**
 * Sends one queued NotificationDelivery: resolves its Setup context, formats
 * the appropriate message (the full READY trade card, or a small
 * status-notice for every other notification type), optionally waits a
 * bounded amount of time for a PRE_TRADE screenshot to attach to a READY
 * alert, then hands off to the configured NotificationProvider
 * (Telegram, or console in development). See docs/notifications.md.
 *
 * TEMPORARY provider errors are recorded (RETRYING) and rethrown so
 * BullMQ's own attempts/backoff (registered on NOTIFICATION_QUEUE in
 * app.module.ts) retries the job - UNLESS this is already the last attempt
 * BullMQ will make (job.attemptsMade >= job.opts.attempts), in which case
 * the row is recorded FAILED (RETRY_ATTEMPTS_EXHAUSTED) and NOT rethrown
 * instead, since NOTIFICATION_QUEUE has no reconciliation sweep and a row
 * left at RETRYING with no further BullMQ attempt coming would be stranded
 * forever. PERMANENT provider errors and SetupContextNotFoundError (a Setup
 * referencing a missing Instrument/Strategy/StrategyVersion/MarketSnapshot
 * row) are both recorded (FAILED) and NOT rethrown — neither a bad
 * token/chat id nor a dangling foreign key will ever succeed on retry, so
 * the job completes rather than exhausting BullMQ's attempts pointlessly;
 * the FAILED row plus its NOTIFICATION_FAILED journal event is the durable
 * record. Any other, unclassified exception is treated conservatively as
 * retryable (RETRYING, rethrown) unless it too is on its last attempt.
 */
@Processor(NOTIFICATION_QUEUE)
@Injectable()
export class NotificationSendProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationSendProcessor.name);

  constructor(
    @Inject(NOTIFICATION_PROVIDER_TOKEN) private readonly provider: NotificationProvider,
    @Inject(SCREENSHOT_STORAGE_TOKEN) private readonly screenshotStorage: ScreenshotStorage,
  ) {
    super();
  }

  async process(job: Job<SendNotificationJobPayload>): Promise<void> {
    const { notificationDeliveryId } = job.data;

    const notification = await notificationDeliveriesRepository.getById(notificationDeliveryId);
    if (!notification) {
      throw new Error(`NotificationDelivery ${notificationDeliveryId} not found`);
    }

    await notificationDeliveriesRepository.markNotificationSending(notificationDeliveryId);

    if (!notification.setupId) {
      // Reserved for a future trade-scoped notification type — nothing in
      // this milestone ever creates a row without setupId (see
      // NotificationDelivery's own doc comment in journal-entities.ts).
      // Unreachable today, but a permanent failure (nothing to retry
      // toward) rather than an unhandled crash if it ever happens.
      await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
        failureCode: "SETUP_NOT_FOUND",
        failureMessage: "NotificationDelivery has no setupId to resolve",
      });
      return;
    }

    const setup = await setupsRepository.getSetup(notification.setupId);
    if (!setup) {
      // A Setup this notification references no longer resolves - treat as
      // a permanent failure (nothing to retry toward), same convention as
      // ScreenshotGenerationProcessor's JOB_TYPE_MISMATCH guard.
      await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
        failureCode: "SETUP_NOT_FOUND",
        failureMessage: `Setup ${notification.setupId} not found`,
      });
      return;
    }

    try {
      const text = await this.formatMessage(notification, setup);
      const imageBuffer =
        notification.notificationType === "SETUP_READY" ? await this.awaitPreTradeScreenshot(setup.id) : null;

      const result = await this.provider.send({ text, imageBuffer });
      await notificationDeliveriesRepository.markNotificationSent(notificationDeliveryId, {
        externalMessageId: result.externalMessageId,
      });
    } catch (error) {
      if (error instanceof NotificationProviderError && error.kind === "PERMANENT") {
        await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
          failureCode: error.failureCode,
          failureMessage: error.message,
        });
        // Deliberately does not rethrow: a PERMANENT failure (bad token,
        // bad chat id) will never succeed on retry, so this job completes
        // rather than exhausting BullMQ's attempts pointlessly.
        return;
      }
      if (error instanceof SetupContextNotFoundError) {
        await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
          failureCode: "SETUP_CONTEXT_NOT_FOUND",
          failureMessage: error.message,
        });
        // Deliberately does not rethrow, same reasoning as the PERMANENT
        // provider-error branch above: a missing Instrument/Strategy/
        // StrategyVersion/MarketSnapshot row is a dangling foreign key,
        // not a transient condition. It will fail identically on every
        // one of BullMQ's 5 attempts, and NOTIFICATION_QUEUE has no
        // reconciliation sweep for exhausted-attempts rows (unlike
        // WebhookReconciliationProcessor for webhook events) - leaving
        // this at RETRYING would eventually strand the row forever,
        // invisible to countRecentFailedNotifications (which only counts
        // FAILED rows). FAILED now is the honest, auditable outcome.
        return;
      }
      const failureCode = error instanceof NotificationProviderError ? error.failureCode : "UNKNOWN_ERROR";
      const failureMessage = error instanceof Error ? error.message : String(error);

      // NOTIFICATION_QUEUE has no reconciliation sweep for exhausted-attempts
      // rows (unlike WEBHOOK_RECONCILIATION_QUEUE's
      // WebhookReconciliationProcessor) - so if BullMQ is not going to make
      // another attempt after this one, marking RETRYING+rethrowing would
      // strand the row at RETRYING forever: invisible to
      // countRecentFailedNotifications (FAILED-only), and unrecoverable by a
      // later requestOrRetryNotification call (which skips any row that
      // isn't already FAILED, treating it as still in flight). job.attemptsMade
      // is the number of attempts made so far *including this one* (BullMQ
      // Job type - see job.d.ts), and job.opts.attempts is this job's
      // configured attempts ceiling (defaultJobOptions.attempts: 5 from
      // NOTIFICATION_QUEUE's registration in app.module.ts, but read from the
      // job itself rather than hardcoded here). ?? 1 mirrors BullMQ's own
      // default of a single attempt when none is configured.
      const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        await notificationDeliveriesRepository.markNotificationFailed(notificationDeliveryId, {
          failureCode: "RETRY_ATTEMPTS_EXHAUSTED",
          failureMessage: `Exhausted all retry attempts after a temporary failure: ${failureMessage}`,
        });
        // Deliberately does not rethrow, same reasoning as the PERMANENT/
        // SetupContextNotFoundError branches above: there is no further
        // BullMQ-driven retry coming regardless (this was the last attempt),
        // so rethrowing would only produce a spurious "failed" job log entry
        // without changing anything - FAILED now is the honest, auditable
        // outcome instead of a row silently stranded at RETRYING forever.
        return;
      }

      await notificationDeliveriesRepository.markNotificationRetrying(notificationDeliveryId, {
        failureCode,
        failureMessage,
      });
      // Rethrow so BullMQ's attempts/backoff actually retries. This is now
      // the deliberately conservative fallback for a genuinely unexpected
      // exception (e.g. a Prisma connection drop) that isn't one of the
      // two classified cases above - not a home for Setup-context lookup
      // failures, which have their own PERMANENT branch now.
      throw error;
    }
  }

  /**
   * Bounded wait for a PRE_TRADE screenshot: polls every
   * NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS up to
   * NOTIFICATION_SCREENSHOT_WAIT_MS total. Returns null (text-only
   * notification) on timeout rather than blocking the READY alert
   * indefinitely - see docs/notifications.md "Screenshot attachment".
   * Exactly one NotificationDelivery row/BullMQ job/Telegram message is
   * ever produced per (setupId, notificationType, templateVersion)
   * regardless of which branch this takes - there is no separate
   * "send the image later" message.
   */
  private async awaitPreTradeScreenshot(setupId: string): Promise<Buffer | null> {
    const deadline = Date.now() + NOTIFICATION_SCREENSHOT_WAIT_MS;
    while (Date.now() < deadline) {
      const ready = await this.findReadyPreTradeScreenshot(setupId);
      if (ready && ready.storageKey) {
        try {
          return await this.screenshotStorage.read(ready.storageKey);
        } catch (error) {
          this.logger.warn(
            `PRE_TRADE screenshot for Setup ${setupId} is READY but unreadable from storage: ${String(error)}`,
          );
          return null;
        }
      }
      await sleep(NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS);
    }
    this.logger.debug(
      `PRE_TRADE screenshot for Setup ${setupId} not READY within ${NOTIFICATION_SCREENSHOT_WAIT_MS}ms; sending text-only.`,
    );
    return null;
  }

  /**
   * No dedicated "most recent ready screenshot for a setup" repository
   * function exists (findMostRecentReadyScreenshot in
   * trade-screenshots.ts is global, across every setup/trade — used only by
   * GET /health) — this lists the setup's screenshots and filters/takes the
   * most recent PRE_TRADE/READY row, per the brief's own "a new per-setup
   * lookup, or list+filter" guidance.
   */
  private async findReadyPreTradeScreenshot(setupId: string): Promise<TradeScreenshot | null> {
    const screenshots = await tradeScreenshotsRepository.listScreenshotsForSetup(setupId);
    const matches = screenshots.filter((s) => s.type === "PRE_TRADE" && s.status === "READY");
    return matches[matches.length - 1] ?? null;
  }

  /**
   * setupsRepository.getSetup returns only the Setup row's own scalar
   * columns — no instrument/strategy/strategyVersion/marketSnapshot
   * relations are included (verified against journal-entities.ts before
   * writing this; the Setup interface there has no such fields). Every
   * display field a template needs is resolved here via the owning
   * repositories instead of assumed to already be attached to `setup`.
   */
  private async formatMessage(notification: NotificationDelivery, setup: Setup): Promise<string> {
    const [instrument, strategy, strategyVersion] = await Promise.all([
      instrumentsRepository.getInstrument(setup.instrumentId),
      strategiesRepository.getStrategyWithVersions(setup.strategyId),
      strategiesRepository.getStrategyVersion(setup.strategyVersionId),
    ]);

    if (!instrument || !strategy || !strategyVersion) {
      throw new SetupContextNotFoundError(
        `Setup ${setup.id} references a missing instrument/strategy/strategyVersion row ` +
          `(instrument=${Boolean(instrument)}, strategy=${Boolean(strategy)}, strategyVersion=${Boolean(strategyVersion)})`,
      );
    }

    if (notification.notificationType !== "SETUP_READY") {
      // notification.notificationType is narrowed to
      // SetupStatusNoticeNotificationType by this check.
      return formatSetupStatusNotice({
        setupId: setup.id,
        notificationType: notification.notificationType,
        instrumentSymbol: instrument.symbol,
        strategyName: strategy.name,
        strategyVersion: strategyVersion.version,
        status: NOTIFICATION_TYPE_TO_SETUP_STATUS[notification.notificationType],
      });
    }

    const marketSnapshot = await marketSnapshotsRepository.getMarketSnapshot(setup.marketSnapshotId);
    if (!marketSnapshot) {
      throw new SetupContextNotFoundError(
        `Setup ${setup.id} references a missing MarketSnapshot ${setup.marketSnapshotId}`,
      );
    }
    const riskCalculation = await riskCalculationsRepository.getLatestRiskCalculation(setup.id);

    return formatReadyTradeCard({
      instrumentSymbol: instrument.symbol,
      direction: setup.direction,
      strategyName: strategy.name,
      strategyVersion: strategyVersion.version,
      timeframe: marketSnapshot.timeframe,
      entry: setup.plannedEntry.toFixed(2),
      stop: setup.plannedStop?.toFixed(2) ?? null,
      target1: setup.plannedTarget1?.toFixed(2) ?? null,
      target2: setup.plannedTarget2?.toFixed(2) ?? null,
      stopDistancePoints: riskCalculation ? `${riskCalculation.stopDistancePoints.toFixed(1)} points` : null,
      riskAmount: riskCalculation ? `$${riskCalculation.estimatedTotalRisk.toFixed(0)}` : null,
      quantity: riskCalculation
        ? `${riskCalculation.calculatedQuantity} contract${riskCalculation.calculatedQuantity === 1 ? "" : "s"}`
        : null,
      riskReward: riskCalculation ? `${riskCalculation.riskReward.toFixed(1)}R` : null,
      expiresAt: setup.expiresAt ? setup.expiresAt.toISOString() : null,
      status: setup.status,
    });
  }
}
