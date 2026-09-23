import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(webhookQueue.add).toHaveBeenCalledWith(expect.any(String), { inboundWebhookEventId: "event-1" });
    expect(webhookQueue.add).toHaveBeenCalledWith(expect.any(String), { inboundWebhookEventId: "event-2" });
  });

  it("does nothing when no events are stale", async () => {
    inboundWebhookEventsRepository.findStaleInboundWebhookEvents.mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal BullMQ Job stub.
    await processor.process({} as any);

    expect(webhookQueue.add).not.toHaveBeenCalled();
  });
});
