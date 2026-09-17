import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { setupsRepository } from "@trading-copilot/database";
import {
  SETUP_EXPIRATION_QUEUE,
  TERMINAL_SETUP_STATUSES,
  type SetupExpirationJobPayload,
} from "@trading-copilot/shared-types";
import { publishRealtimeEvent } from "../common/realtime-publisher";

const WORKER_CONCURRENCY = process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 2;

/**
 * Consumes the delayed "setup-expiration" job scheduled by
 * tradingview-webhook.processor.ts right after it creates a TRADINGVIEW
 * Setup. If the Setup is already in a terminal state (REJECTED,
 * INVALIDATED, or EXPIRED) - meaning a human, or another process, already
 * resolved it before the delay elapsed - this is a no-op: a terminal
 * status is never overwritten, including by expiration. This also covers
 * READY: an unactioned READY setup expires exactly like WATCH/PREPARE,
 * since a human didn't take the trade in time (docs/tradingview-setup.md
 * "Setup expiration").
 */
@Processor(SETUP_EXPIRATION_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class SetupExpirationProcessor extends WorkerHost {
  private readonly logger = new Logger(SetupExpirationProcessor.name);

  async process(job: Job<SetupExpirationJobPayload>): Promise<void> {
    const { setupId } = job.data;

    const setup = await setupsRepository.getSetup(setupId);
    if (!setup) {
      this.logger.warn(`Setup ${setupId} not found for scheduled expiration; nothing to do`);
      return;
    }

    if (TERMINAL_SETUP_STATUSES.includes(setup.status)) {
      this.logger.log(
        `Setup ${setupId} already terminal (${setup.status}) before its expiration job ran; no-op`,
      );
      return;
    }

    const expired = await setupsRepository.transitionSetupStatus(setupId, { status: "EXPIRED" });

    await publishRealtimeEvent({
      type: "setup.expired",
      timestamp: new Date().toISOString(),
      setupId: expired.id,
      instrumentId: expired.instrumentId,
      status: expired.status,
      direction: expired.direction,
    });
  }
}
