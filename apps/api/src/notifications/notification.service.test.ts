import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationService } from "./notification.service";

vi.mock("@trading-copilot/database", () => ({
  notificationDeliveriesRepository: { requestOrRetryNotification: vi.fn() },
}));

import { notificationDeliveriesRepository } from "@trading-copilot/database";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Default: no existing BullMQ job for this id, so enqueueNotificationIfNeeded
 * falls through to the add() branch — mirrors screenshot.service.test.ts's
 * own makeQueue() helper.
 */
function makeQueue() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(undefined),
  };
}

/** A minimal stub of a real BullMQ Job, just enough for enqueueNotificationIfNeeded's state check. */
function makeJobStub(state: string) {
  return {
    id: "stub-job-id",
    getState: vi.fn().mockResolvedValue(state),
    retry: vi.fn().mockResolvedValue(undefined),
  };
}

describe("NotificationService.requestNotification", () => {
  it("requests idempotently, then enqueues with a deterministic jobId when not already in flight", async () => {
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "QUEUED" } as never,
      alreadyInFlight: false,
    });

    const queue = makeQueue();
    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(notificationDeliveriesRepository.requestOrRetryNotification).toHaveBeenCalledWith(
      expect.objectContaining({ setupId: "setup-1", notificationType: "SETUP_READY", provider: "TELEGRAM" }),
    );
    expect(queue.getJob).toHaveBeenCalledWith("notification-1");
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      { notificationDeliveryId: "notification-1" },
      { jobId: "notification-1" },
    );
  });

  it("uses provider CONSOLE when NOTIFICATION_MODE=console", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "console");
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "QUEUED" } as never,
      alreadyInFlight: false,
    });

    const queue = makeQueue();
    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(notificationDeliveriesRepository.requestOrRetryNotification).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "CONSOLE" }),
    );
  });

  it("still (re-)enqueues when already in flight but the row is still QUEUED and no job exists (recovers a row whose original enqueue never happened)", async () => {
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "QUEUED" } as never,
      alreadyInFlight: true,
    });

    const queue = makeQueue();
    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      { notificationDeliveryId: "notification-1" },
      { jobId: "notification-1" },
    );
  });

  it("retries (never blindly re-adds) when the row is QUEUED and the existing job has reached failed — the FAILED-retry regression fix", async () => {
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "QUEUED" } as never,
      alreadyInFlight: false,
    });
    const queue = makeQueue();
    const jobStub = makeJobStub("failed");
    queue.getJob.mockResolvedValue(jobStub);

    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(jobStub.retry).toHaveBeenCalledWith("failed");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("logs a warning and skips (never re-adds or retries) when the existing job has reached completed while the row is still QUEUED", async () => {
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "QUEUED" } as never,
      alreadyInFlight: true,
    });
    const queue = makeQueue();
    const jobStub = makeJobStub("completed");
    queue.getJob.mockResolvedValue(jobStub);

    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(jobStub.retry).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(["waiting", "active", "delayed"])(
    "skips silently (never re-adds or retries) when the existing job is still %s",
    async (state) => {
      vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
        notification: { id: "notification-1", status: "QUEUED" } as never,
        alreadyInFlight: true,
      });
      const queue = makeQueue();
      const jobStub = makeJobStub(state);
      queue.getJob.mockResolvedValue(jobStub);

      const service = new NotificationService(queue as never);
      await service.requestNotification("setup-1", "SETUP_READY");

      expect(jobStub.retry).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it("does not touch BullMQ at all when already in flight and past QUEUED (e.g. SENDING)", async () => {
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "SENDING" } as never,
      alreadyInFlight: true,
    });

    const queue = makeQueue();
    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not touch BullMQ at all when already in flight and SENT", async () => {
    vi.mocked(notificationDeliveriesRepository.requestOrRetryNotification).mockResolvedValue({
      notification: { id: "notification-1", status: "SENT" } as never,
      alreadyInFlight: true,
    });

    const queue = makeQueue();
    const service = new NotificationService(queue as never);
    await service.requestNotification("setup-1", "SETUP_READY");

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
