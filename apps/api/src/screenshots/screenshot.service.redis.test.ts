import { Logger } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScreenshotGenerationJobPayload } from "@trading-copilot/shared-types";
import { createRedisConnectionOptions } from "../common/redis-connection";
import { enqueueJobIfNeeded } from "./screenshot.service";

/**
 * Proves the actual mechanism enqueueJobIfNeeded relies on: BullMQ's real
 * dedup-by-jobId and job-state behavior against real Redis, not a mock of
 * it - specifically the FAILED -> retry path, since that's exactly what a
 * mocked `queue.add`/`queue.getJob` (screenshot.service.test.ts) cannot
 * verify: a mock can be told to return whatever state a test wants, but it
 * can't prove BullMQ's own add()-with-an-existing-jobId behavior actually
 * no-ops the way the regression fix assumes. Mirrors
 * apps/worker/src/webhook-reconciliation/webhook-reconciliation.processor.test.ts's
 * own real-Redis suite exactly, including the dedicated-queue-name and
 * REDIS_URL guard rationale below.
 *
 * Guarded by describe.skipIf(!process.env.REDIS_URL): without REDIS_URL
 * set, createRedisConnectionOptions() falls back to redis://localhost:6379,
 * which on this machine belongs to an unrelated project's Redis container.
 * This suite must never create/obliterate a queue there - it only runs
 * when REDIS_URL is explicitly set to this project's Redis (see .env,
 * redis://localhost:6380 in local dev).
 */
describe.skipIf(!process.env.REDIS_URL)(
  "enqueueJobIfNeeded job-state-aware retry (real BullMQ against Redis)",
  () => {
    const queueName = `screenshot-generation-jobstate-test-${Date.now()}`;
    const jobName = "generate-pre-trade-screenshot";
    let queue: Queue<ScreenshotGenerationJobPayload>;
    let worker: Worker<ScreenshotGenerationJobPayload, void> | undefined;
    const logger = new Logger("screenshot.service.redis.test");

    beforeEach(() => {
      queue = new Queue(queueName, { connection: createRedisConnectionOptions() });
    });

    afterEach(async () => {
      await worker?.close();
      worker = undefined;
      await queue.obliterate({ force: true });
      await queue.close();
    });

    it("adds a fresh job when none exists yet for this screenshotId", async () => {
      const screenshotId = `screenshot-fresh-${Date.now()}`;

      await enqueueJobIfNeeded(queue, jobName, screenshotId, logger);

      const job = await queue.getJob(screenshotId);
      expect(job).toBeDefined();
      expect(job?.data).toEqual({ screenshotId });
      const waiting = await queue.getWaiting();
      expect(waiting.filter((j) => j.id === screenshotId)).toHaveLength(1);
    });

    it("does not duplicate when a job is already waiting under the same jobId (BullMQ's own dedup, not a re-add)", async () => {
      const screenshotId = `screenshot-waiting-${Date.now()}`;
      await queue.add(jobName, { screenshotId }, { jobId: screenshotId });

      await enqueueJobIfNeeded(queue, jobName, screenshotId, logger);

      const waiting = await queue.getWaiting();
      expect(waiting.filter((j) => j.id === screenshotId)).toHaveLength(1);
    });

    it(
      "retries a job that has genuinely reached the failed state, rather than silently no-op-ing via a blind add() - " +
        "the exact regression this function exists to fix",
      async () => {
        const screenshotId = `screenshot-failed-${Date.now()}`;

        // Drive a real job to a genuine `failed` state via a real Worker
        // with attempts: 1 (matching SCREENSHOT_QUEUE's real
        // defaultJobOptions), so this is the worker's own single attempt
        // failing outright - no automatic BullMQ retry muddying the
        // state, exactly as a real render failure would leave it.
        await queue.add(jobName, { screenshotId }, { jobId: screenshotId, attempts: 1 });
        const failingWorker = new Worker<ScreenshotGenerationJobPayload, void>(
          queueName,
          async (): Promise<void> => {
            throw new Error("simulated render failure");
          },
          { connection: createRedisConnectionOptions() },
        );
        worker = failingWorker;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timed out waiting for job to fail")), 10_000);
          failingWorker.on("failed", (job) => {
            if (job?.id === screenshotId) {
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        await failingWorker.close();
        worker = undefined;

        const stuckJob = await queue.getJob(screenshotId);
        expect(await stuckJob?.getState()).toBe("failed");

        // Before the fix, enqueueJobIfNeeded (then just a blind
        // `queue.add(..., { jobId })`) would silently no-op here, because
        // BullMQ dedups by jobId across the failed set too - the row would
        // stay REQUESTED forever, and every subsequent retry attempt would
        // hit this exact same collision. After the fix, it detects the
        // failed state and calls job.retry("failed") instead, moving the
        // job back to waiting so it can actually run again.
        await enqueueJobIfNeeded(queue, jobName, screenshotId, logger);

        const retriedJob = await queue.getJob(screenshotId);
        const state = await retriedJob?.getState();
        expect(state).not.toBe("failed");
        expect(["waiting", "active"]).toContain(state);
      },
      15_000,
    );

    it("logs a warning and does not retry/re-add when the existing job has reached completed", async () => {
      const screenshotId = `screenshot-completed-${Date.now()}`;

      await queue.add(jobName, { screenshotId }, { jobId: screenshotId, attempts: 1 });
      const succeedingWorker = new Worker<ScreenshotGenerationJobPayload, void>(
        queueName,
        async (): Promise<void> => undefined,
        { connection: createRedisConnectionOptions() },
      );
      worker = succeedingWorker;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for job to complete")), 10_000);
        succeedingWorker.on("completed", (job) => {
          if (job.id === screenshotId) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await succeedingWorker.close();
      worker = undefined;

      const warnSpy = { called: false, message: "" };
      const spyLogger = {
        warn: (message: string) => {
          warnSpy.called = true;
          warnSpy.message = message;
        },
      } as unknown as Logger;

      await enqueueJobIfNeeded(queue, jobName, screenshotId, spyLogger);

      expect(warnSpy.called).toBe(true);
      expect(warnSpy.message).toContain(screenshotId);
      const completedJob = await queue.getJob(screenshotId);
      expect(await completedJob?.getState()).toBe("completed");
    }, 15_000);
  },
);
