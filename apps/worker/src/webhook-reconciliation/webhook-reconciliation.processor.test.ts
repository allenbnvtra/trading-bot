import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedisConnectionOptions } from "../common/redis-connection";
import { WebhookReconciliationProcessor } from "./webhook-reconciliation.processor";

const { inboundWebhookEventsRepository } = vi.hoisted(() => ({
  inboundWebhookEventsRepository: { findStaleInboundWebhookEvents: vi.fn() },
}));

vi.mock("@trading-copilot/database", () => ({ inboundWebhookEventsRepository }));

function makeQueue() {
  return { add: vi.fn().mockResolvedValue(undefined), upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
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

  it("re-enqueues the processing job for every stale event found", async () => {
    inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([
      { id: "event-1" },
      { id: "event-2" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
    await processor.process({} as any);

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

    expect(webhookQueue.add).not.toHaveBeenCalled();
  });
});

describe("WebhookReconciliationProcessor jobId dedup (real BullMQ against Redis)", () => {
  // Proves the actual mechanism the jobId fix relies on: BullMQ's own
  // dedup-by-jobId behavior, not a mock of it. A dedicated queue name keeps
  // this isolated from the real "tradingview-webhook-event" queue any
  // running worker might be consuming from. This is a real Queue instance
  // against the local Redis (docker compose) — not a mock — since the point
  // is to prove BullMQ's real behavior, per the fix ruling.
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
});
