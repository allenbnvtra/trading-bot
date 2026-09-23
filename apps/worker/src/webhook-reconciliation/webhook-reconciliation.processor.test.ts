import { Logger } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedisConnectionOptions } from "../common/redis-connection";
import { WebhookReconciliationProcessor } from "./webhook-reconciliation.processor";

const { inboundWebhookEventsRepository } = vi.hoisted(() => ({
  inboundWebhookEventsRepository: { findStaleInboundWebhookEvents: vi.fn() },
}));

vi.mock("@trading-copilot/database", () => ({ inboundWebhookEventsRepository }));

function makeQueue() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    // Default: no existing job for this id, so reconcileEvent() falls
    // through to the add() branch - matches every pre-existing test below,
    // none of which care about job-state-awareness.
    getJob: vi.fn().mockResolvedValue(undefined),
  };
}

/** A minimal stub of a real BullMQ Job, just enough for reconcileEvent()'s state check. */
function makeJobStub(state: string) {
  return {
    id: "stub-job-id",
    getState: vi.fn().mockResolvedValue(state),
    retry: vi.fn().mockResolvedValue(undefined),
  };
}

describe("WebhookReconciliationProcessor", () => {
  let reconciliationQueue: ReturnType<typeof makeQueue>;
  let webhookQueue: ReturnType<typeof makeQueue>;
  let processor: WebhookReconciliationProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    reconciliationQueue = makeQueue();
    webhookQueue = makeQueue();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BullMQ Queue mock.
    processor = new WebhookReconciliationProcessor(reconciliationQueue as any, webhookQueue as any);
  });

  it("upserts the repeatable job scheduler with a fixed jobSchedulerId on module init", async () => {
    await processor.onModuleInit();

    expect(reconciliationQueue.upsertJobScheduler).toHaveBeenCalledWith(
      "webhook-reconciliation-repeatable",
      expect.objectContaining({ every: expect.any(Number) }),
      expect.objectContaining({ name: expect.any(String) }),
    );
  });

  it("upserting the scheduler again (simulating a worker restart) never creates a second schedule", async () => {
    await processor.onModuleInit();
    await processor.onModuleInit();

    expect(reconciliationQueue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(reconciliationQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
      1,
      "webhook-reconciliation-repeatable",
      expect.anything(),
      expect.anything(),
    );
    expect(reconciliationQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
      2,
      "webhook-reconciliation-repeatable",
      expect.anything(),
      expect.anything(),
    );
  });

  it("adds a fresh job (jobId dedup shape unchanged) when no job exists yet for a stale event", async () => {
    inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([
      { id: "event-1" },
      { id: "event-2" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
    await processor.process({} as any);

    expect(webhookQueue.getJob).toHaveBeenCalledWith("event-1");
    expect(webhookQueue.getJob).toHaveBeenCalledWith("event-2");
    expect(webhookQueue.add).toHaveBeenCalledTimes(2);
    expect(webhookQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      { inboundWebhookEventId: "event-1" },
      { jobId: "event-1" },
    );
    expect(webhookQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      { inboundWebhookEventId: "event-2" },
      { jobId: "event-2" },
    );
  });

  it("does nothing when no events are stale", async () => {
    inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
    await processor.process({} as any);

    expect(webhookQueue.getJob).not.toHaveBeenCalled();
    expect(webhookQueue.add).not.toHaveBeenCalled();
  });

  it("retries the existing job (never re-adds) when it has reached the failed state", async () => {
    inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([{ id: "event-failed" }]);
    const jobStub = makeJobStub("failed");
    webhookQueue.getJob.mockResolvedValue(jobStub);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
    await processor.process({} as any);

    expect(jobStub.retry).toHaveBeenCalledWith("failed");
    expect(webhookQueue.add).not.toHaveBeenCalled();
  });

  it("logs a warning and skips (never re-adds or retries) when the existing job has reached completed", async () => {
    inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([{ id: "event-completed" }]);
    const jobStub = makeJobStub("completed");
    webhookQueue.getJob.mockResolvedValue(jobStub);
    const loggerWarnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
    await processor.process({} as any);

    expect(jobStub.retry).not.toHaveBeenCalled();
    expect(webhookQueue.add).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining("event-completed"));
    loggerWarnSpy.mockRestore();
  });

  it.each(["waiting", "active", "delayed"])(
    "skips silently (never re-adds or retries) when the existing job is still %s",
    async (state) => {
      inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([{ id: "event-inflight" }]);
      const jobStub = makeJobStub(state);
      webhookQueue.getJob.mockResolvedValue(jobStub);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
      await processor.process({} as any);

      expect(jobStub.retry).not.toHaveBeenCalled();
      expect(webhookQueue.add).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(!process.env.REDIS_URL)(
  "WebhookReconciliationProcessor jobId dedup (real BullMQ against Redis)",
  () => {
    // Proves the actual mechanism the jobId fix relies on: BullMQ's own
    // dedup-by-jobId behavior, not a mock of it. A dedicated queue name keeps
    // this isolated from the real "tradingview-webhook-event" queue any
    // running worker might be consuming from. This is a real Queue instance
    // against the local Redis (docker compose) — not a mock — since the point
    // is to prove BullMQ's real behavior, per the fix ruling.
    //
    // Guarded by describe.skipIf(!process.env.REDIS_URL): without REDIS_URL
    // set, createRedisConnectionOptions() falls back to
    // redis://localhost:6379, which on some machines belongs to an unrelated
    // project. This suite must never create/obliterate a queue there.
    const queueName = `webhook-reconciliation-dedup-test-${Date.now()}`;
    let queue: Queue<{ inboundWebhookEventId: string }>;

    beforeEach(() => {
      queue = new Queue(queueName, { connection: createRedisConnectionOptions() });
    });

    afterEach(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });

    it("adding a job with the same jobId from two call sites results in only one job in the queue", async () => {
      const eventId = "event-jobid-dedup-test";

      // Shape mirrors the "original ingest" enqueue in tradingview-webhook.service.ts.
      const original = await queue.add("process", { inboundWebhookEventId: eventId }, { jobId: eventId });
      // Shape mirrors WebhookReconciliationProcessor's re-enqueue for the same event.
      const reEnqueued = await queue.add("process", { inboundWebhookEventId: eventId }, { jobId: eventId });

      // BullMQ returns the existing job (a no-op) rather than creating a
      // second one when a job with that jobId is already waiting/active.
      expect(reEnqueued.id).toBe(original.id);

      const waiting = await queue.getWaiting();
      const active = await queue.getActive();
      const delayed = await queue.getDelayed();
      const jobsForEvent = [...waiting, ...active, ...delayed].filter(
        (job) => job.data.inboundWebhookEventId === eventId,
      );
      expect(jobsForEvent).toHaveLength(1);
    });
  },
);

describe.skipIf(!process.env.REDIS_URL)(
  "WebhookReconciliationProcessor failed-job recovery (real BullMQ against Redis)",
  () => {
    // Finding I-1: proves the fix for the case a bare jobId-dedup `add()`
    // gets permanently wrong - once a job for an event reaches `failed`,
    // BullMQ retains that job hash forever (neither queue sets
    // removeOnFail), so a bare `add({ jobId: event.id })` from a later sweep
    // just silently returns the existing failed job every time, and the
    // event never gets reprocessed. This test drives a real job to a real
    // `failed` state against real Redis (a real Worker whose processor
    // throws, with attempts: 1 so it fails on the first try), then runs the
    // fixed WebhookReconciliationProcessor.process() against that same real
    // queue and confirms the job is retried (moves out of `failed`) instead
    // of being silently ignored.
    //
    // Guarded by describe.skipIf(!process.env.REDIS_URL) for the same reason
    // as the dedup suite above: an unguarded fallback could hit an unrelated
    // project's Redis on localhost:6379.
    const queueName = `webhook-reconciliation-failed-state-test-${Date.now()}`;
    let queue: Queue<{ inboundWebhookEventId: string }>;
    let worker: Worker<{ inboundWebhookEventId: string }> | undefined;

    beforeEach(() => {
      queue = new Queue(queueName, { connection: createRedisConnectionOptions() });
    });

    afterEach(async () => {
      await worker?.close();
      worker = undefined;
      await queue.obliterate({ force: true });
      await queue.close();
    });

    it("reconciles a job stuck in the failed state by retrying it, rather than silently no-op'ing via add()", async () => {
      const eventId = "event-failed-recovery-test";

      // A worker whose processor always throws, with attempts: 1 on the
      // job itself, so the job reaches `failed` deterministically on its
      // very first (and only) attempt - no flaky timing around multiple
      // retries.
      worker = new Worker<{ inboundWebhookEventId: string }>(
        queueName,
        async () => {
          throw new Error("simulated processing failure, forcing this job to `failed`");
        },
        { connection: createRedisConnectionOptions() },
      );

      const job = await queue.add(
        "process",
        { inboundWebhookEventId: eventId },
        { jobId: eventId, attempts: 1 },
      );

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe("failed");
        },
        { timeout: 10_000, interval: 100 },
      );

      // Stop the worker before reconciling: this test wants to observe the
      // reconciliation processor's own effect on the job (moving it out of
      // `failed`), not race against the worker immediately picking it back
      // up and re-failing it.
      await worker.close();
      worker = undefined;

      const reconciliationQueueStub = { upsertJobScheduler: vi.fn() };
      inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([{ id: eventId }]);
      const addSpy = vi.spyOn(queue, "add");

      const processor = new WebhookReconciliationProcessor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BullMQ Queue mock for the unused reconciliation-scheduler queue.
        reconciliationQueueStub as any,
        queue,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
      await processor.process({} as any);

      // The fix's whole point: the job actually left the failed state
      // (job.retry("failed") was used), proving this isn't the old bug
      // where a bare add() would silently return the still-failed job
      // unchanged.
      const stateAfter = await job.getState();
      expect(stateAfter).not.toBe("failed");
      expect(stateAfter).toBe("waiting");
      expect(addSpy).not.toHaveBeenCalled();
    });
  },
);
