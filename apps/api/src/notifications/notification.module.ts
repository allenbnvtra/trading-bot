import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { NOTIFICATION_QUEUE } from "@trading-copilot/shared-types";
import { NotificationService } from "./notification.service";

/**
 * Registers NOTIFICATION_QUEUE as a producer, mirroring
 * screenshot.module.ts's split with apps/worker's own separate registration
 * of the same queue name as a consumer. This is the established, correct
 * pattern in this codebase for a queue that both an API-side producer and a
 * worker-side consumer need their own Queue/Worker instance for — not a
 * duplicate-registration bug.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: NOTIFICATION_QUEUE,
      defaultJobOptions: { attempts: 1 },
    }),
  ],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
