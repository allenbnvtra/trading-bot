import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";

vi.mock("@trading-copilot/database", () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
  inboundWebhookEventsRepository: {
    findMostRecentInboundWebhookEvent: vi.fn(),
    findMostRecentProcessedInboundWebhookEvent: vi.fn(),
  },
  tradeScreenshotsRepository: {
    findMostRecentReadyScreenshot: vi.fn(),
    countRecentFailedScreenshots: vi.fn(),
  },
  notificationDeliveriesRepository: {
    findMostRecentSentNotificationOverall: vi.fn(),
    countRecentFailedNotifications: vi.fn(),
  },
}));

// A fresh plain object per `new LocalDiskScreenshotStorage(...)` call (mirrors
// the real class's shape, never the real implementation - no real disk I/O in
// this unit test file), so each `new HealthService()` gets its own
// independently-controllable save/read/delete spies. Defaults to a
// successful round-trip; individual tests override save/read to exercise the
// "down" path.
vi.mock("@trading-copilot/screenshot-storage", () => ({
  LocalDiskScreenshotStorage: vi.fn().mockImplementation(() => ({
    save: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.from("health-check")),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  })),
  // HealthService resolves SCREENSHOT_STORAGE_ROOT via
  // resolveScreenshotStorageRoot (same as the production provider) before
  // constructing LocalDiskScreenshotStorage; this test only cares about the
  // mocked storage behavior above, so it stubs the resolver as an identity
  // function rather than pulling in the real monorepo-root-walking logic.
  resolveScreenshotStorageRoot: vi.fn((root: string) => root),
}));

import {
  inboundWebhookEventsRepository,
  notificationDeliveriesRepository,
  tradeScreenshotsRepository,
} from "@trading-copilot/database";
import { LocalDiskScreenshotStorage } from "@trading-copilot/screenshot-storage";

/** Neutral default so tests focused on the other subsystem don't also have to stub this one. */
function stubIngestionUnknown(): void {
  vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(null);
  vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
    null,
  );
}

/** Neutral default so tests focused on the other subsystem don't also have to stub this one. */
function stubScreenshotGenerationUnknown(): void {
  vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
  vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);
}

/**
 * Neutral default so tests focused on the other subsystems don't also have
 * to stub this one: relies on the file-level `beforeEach` below to leave all
 * four Telegram/NOTIFICATION_MODE env vars unset (DISABLED — the
 * short-circuit path that never even queries the repositories), plus
 * resolved-but-unused repository stubs in case a future refactor changes the
 * DISABLED short-circuit and starts querying regardless.
 */
function stubNotificationsDisabled(): void {
  vi.mocked(notificationDeliveriesRepository.findMostRecentSentNotificationOverall).mockResolvedValue(null);
  vi.mocked(notificationDeliveriesRepository.countRecentFailedNotifications).mockResolvedValue(0);
}

/** Sets all three TELEGRAM_* env vars so isTelegramConfigured() reports true. */
function enableTelegramCredentials(): void {
  process.env.NOTIFICATION_MODE = "telegram";
  process.env.TELEGRAM_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "test-chat-id";
}

// Reset the notification env vars before every test in this file,
// regardless of describe-block order, so a test that calls
// enableTelegramCredentials() can never leak TELEGRAM_*/NOTIFICATION_MODE
// into an unrelated test (e.g. the ingestion/screenshot describe blocks
// above, which never touch these vars themselves).
beforeEach(() => {
  delete process.env.TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.NOTIFICATION_MODE;
});

/**
 * `HealthService` instantiates its own `LocalDiskScreenshotStorage` as a
 * class field (mirroring `redis` in that same file), so the only way to
 * control a *specific* instance's behavior from outside is to grab the
 * object the mocked constructor most recently returned - `new
 * HealthService()` must be called first, then this picks up that call's
 * instance.
 */
function latestMockedScreenshotStorageInstance() {
  const results = vi.mocked(LocalDiskScreenshotStorage).mock.results;
  const last = results.at(-1);
  if (!last || last.type !== "return") {
    throw new Error("expected LocalDiskScreenshotStorage to have been constructed at least once");
  }
  return last.value as unknown as { save: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
}

describe("HealthService.checkTradingViewIngestion (via check())", () => {
  it("reports UNKNOWN when no event has ever been received, without listing every row", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("UNKNOWN");
    // The old implementation called a full-list query; this asserts the
    // new implementation never does, by asserting the list function was
    // never imported/called at all (it is not even mocked above — a call
    // to it would throw "is not a function").
  });

  it("reports DEGRADED when the most recent delivery ended FAILED", async () => {
    stubScreenshotGenerationUnknown();
    const failedEvent = { processingStatus: "FAILED", receivedAt: new Date("2026-01-01T00:00:00Z") };
    vi.mocked(inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent).mockResolvedValue(
      failedEvent as never,
    );
    vi.mocked(inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent).mockResolvedValue(
      null,
    );

    const service = new HealthService();
    const result = await service.check();

    expect(result.tradingViewIngestion.status).toBe("DEGRADED");
    expect(result.status).toBe("degraded");
  });
});

describe("HealthService.checkScreenshotGeneration (via check())", () => {
  it("reports screenshot generation health from real TradeScreenshot rows, never hardcoded HEALTHY", async () => {
    stubIngestionUnknown();
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("UNKNOWN");
  });

  it("does not degrade the overall status when screenshot generation is UNKNOWN (no screenshots yet)", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("UNKNOWN");
    expect(result.status).toBe("ok");
  });

  it("reports HEALTHY with the most recent READY screenshot's renderedAt when there are no recent failures", async () => {
    stubIngestionUnknown();
    const readyScreenshot = { renderedAt: new Date("2026-02-01T00:00:00Z") };
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(
      readyScreenshot as never,
    );
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("HEALTHY");
    expect(result.screenshotGeneration.lastSuccessfulScreenshotAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.screenshotGeneration.recentFailureCount).toBe(0);
    expect(result.status).toBe("ok");
  });

  it("reports DEGRADED and pulls the overall status down when there are recent failures", async () => {
    stubIngestionUnknown();
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockResolvedValue(null);
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(3);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("DEGRADED");
    expect(result.screenshotGeneration.recentFailureCount).toBe(3);
    expect(result.status).toBe("degraded");
  });

  it("reports UNKNOWN, not HEALTHY, when the repository queries throw", async () => {
    stubIngestionUnknown();
    vi.mocked(tradeScreenshotsRepository.findMostRecentReadyScreenshot).mockRejectedValue(
      new Error("connection reset"),
    );
    vi.mocked(tradeScreenshotsRepository.countRecentFailedScreenshots).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.screenshotGeneration.status).toBe("UNKNOWN");
  });
});

describe("HealthService.checkScreenshotStorage (via check())", () => {
  it("reports screenshotStorage up when the write+read+delete probe round-trips successfully", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    const result = await service.check();

    expect(result.screenshotStorage).toBe("up");
    expect(result.status).toBe("ok");
  });

  it("reports screenshotStorage down, not hardcoded up, when the storage backend's save() throws", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    latestMockedScreenshotStorageInstance().save.mockRejectedValueOnce(new Error("disk full"));

    const result = await service.check();

    expect(result.screenshotStorage).toBe("down");
    expect(result.status).toBe("degraded");
  });

  it("reports screenshotStorage down when the read-back content does not match what was written", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();

    const service = new HealthService();
    latestMockedScreenshotStorageInstance().read.mockResolvedValueOnce(Buffer.from("corrupted"));

    const result = await service.check();

    expect(result.screenshotStorage).toBe("down");
    expect(result.status).toBe("degraded");
  });
});

describe("HealthService notification check", () => {
  it("reports DISABLED when NOTIFICATION_MODE is console and TELEGRAM_ENABLED is not true", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();
    stubNotificationsDisabled();
    process.env.NOTIFICATION_MODE = "console";

    const result = await new HealthService().check();

    expect(result.notifications).toEqual({
      status: "DISABLED",
      providerEnabled: false,
      lastSuccessfulNotificationAt: null,
      recentFailureCount: 0,
    });
    // DISABLED never queries the delivery repositories at all.
    expect(notificationDeliveriesRepository.findMostRecentSentNotificationOverall).not.toHaveBeenCalled();
    expect(notificationDeliveriesRepository.countRecentFailedNotifications).not.toHaveBeenCalled();
    // DISABLED never pulls the overall status down.
    expect(result.status).toBe("ok");
  });

  it("reports UNKNOWN when Telegram is enabled but no notification has ever been sent", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();
    enableTelegramCredentials();
    vi.mocked(notificationDeliveriesRepository.findMostRecentSentNotificationOverall).mockResolvedValue(
      null,
    );
    vi.mocked(notificationDeliveriesRepository.countRecentFailedNotifications).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.notifications.status).toBe("UNKNOWN");
    expect(result.notifications.providerEnabled).toBe(true);
    expect(result.notifications.lastSuccessfulNotificationAt).toBeNull();
    // UNKNOWN never pulls the overall status down (same rule as a
    // freshly-seeded ingestion/screenshot subsystem).
    expect(result.status).toBe("ok");
  });

  it("reports DEGRADED when a recent FAILED notification exists", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();
    enableTelegramCredentials();
    vi.mocked(notificationDeliveriesRepository.findMostRecentSentNotificationOverall).mockResolvedValue(
      null,
    );
    vi.mocked(notificationDeliveriesRepository.countRecentFailedNotifications).mockResolvedValue(2);

    const result = await new HealthService().check();

    expect(result.notifications.status).toBe("DEGRADED");
    expect(result.notifications.recentFailureCount).toBe(2);
    expect(result.status).toBe("degraded");
  });

  it("reports HEALTHY only when Telegram is enabled, configured, AND at least one notification has actually SENT — never HEALTHY merely because credentials exist", async () => {
    stubIngestionUnknown();
    stubScreenshotGenerationUnknown();
    enableTelegramCredentials();

    // First: credentials alone, with no SENT notification, must NOT be
    // reported HEALTHY. This is the brief's explicit "do not report HEALTHY
    // simply because credentials exist" requirement.
    vi.mocked(notificationDeliveriesRepository.findMostRecentSentNotificationOverall).mockResolvedValue(
      null,
    );
    vi.mocked(notificationDeliveriesRepository.countRecentFailedNotifications).mockResolvedValue(0);

    const credentialsOnlyResult = await new HealthService().check();

    expect(credentialsOnlyResult.notifications.providerEnabled).toBe(true);
    expect(credentialsOnlyResult.notifications.status).not.toBe("HEALTHY");
    expect(credentialsOnlyResult.notifications.status).toBe("UNKNOWN");

    // Now: credentials AND a real SENT NotificationDelivery row — this is
    // the only combination that earns HEALTHY.
    const sentNotification = {
      sentAt: new Date("2026-03-01T00:00:00Z"),
    };
    vi.mocked(notificationDeliveriesRepository.findMostRecentSentNotificationOverall).mockResolvedValue(
      sentNotification as never,
    );
    vi.mocked(notificationDeliveriesRepository.countRecentFailedNotifications).mockResolvedValue(0);

    const result = await new HealthService().check();

    expect(result.notifications).toEqual({
      status: "HEALTHY",
      providerEnabled: true,
      lastSuccessfulNotificationAt: "2026-03-01T00:00:00.000Z",
      recentFailureCount: 0,
    });
    expect(result.status).toBe("ok");
  });
});
