import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_TEMPLATE_VERSION,
  SEND_NOTIFICATION_JOB,
  type NotificationType,
  type SendNotificationJobPayload,
} from "@trading-copilot/shared-types";
import { notificationDeliveriesRepository } from "@trading-copilot/database";

/**
 * Mirrors ScreenshotService's requestOrRetryScreenshot + enqueueIfNeeded
 * split exactly: notificationDeliveriesRepository.requestOrRetryNotification
 * is the idempotency boundary (a DB constraint, never re-implemented here),
 * this service only decides whether a BullMQ job needs enqueuing on top of
 * the (possibly pre-existing) row it returns.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue<SendNotificationJobPayload>) {}

  async requestNotification(setupId: string, notificationType: NotificationType): Promise<void> {
    const provider = process.env.NOTIFICATION_MODE === "console" ? "CONSOLE" : "TELEGRAM";
    const { notification, alreadyInFlight } = await notificationDeliveriesRepository.requestOrRetryNotification({
      setupId,
      provider,
      notificationType,
      templateVersion: NOTIFICATION_TEMPLATE_VERSION,
    });

    if (alreadyInFlight && notification.status !== "QUEUED") {
      return;
    }
    await enqueueNotificationIfNeeded(this.queue, notification.id, this.logger);
  }
}

/**
 * Job-state-aware enqueue, mirroring enqueueJobIfNeeded in
 * screenshot.service.ts exactly (and WebhookReconciliationProcessor.reconcileEvent
 * before that) — see either for the full rationale: BullMQ's jobId dedup
 * only blocks a duplicate add() while a job is retained under ANY state,
 * including `failed` (this queue does not set removeOnFail), so a blind
 * add() would permanently no-op once a job has genuinely failed and been
 * reset to QUEUED for retry.
 */
export async function enqueueNotificationIfNeeded(
  queue: Queue<SendNotificationJobPayload>,
  notificationDeliveryId: string,
  logger: Logger,
): Promise<void> {
  const existingJob = await queue.getJob(notificationDeliveryId);

  if (!existingJob) {
    await queue.add(SEND_NOTIFICATION_JOB, { notificationDeliveryId }, { jobId: notificationDeliveryId });
    return;
  }

  const state = await existingJob.getState();
  if (state === "failed") {
    await existingJob.retry("failed");
    return;
  }
  if (state === "completed") {
    logger.warn(
      `NotificationDelivery ${notificationDeliveryId} has a completed BullMQ job while its row is still QUEUED - skipping re-enqueue; this indicates a bug elsewhere.`,
    );
    return;
  }
  // waiting/active/delayed - already in flight.
}
