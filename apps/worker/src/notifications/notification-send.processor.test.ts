import { Decimal } from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_SCREENSHOT_WAIT_MS } from "@trading-copilot/shared-types";
import { NotificationProviderError } from "./notification-provider";
import { NotificationSendProcessor } from "./notification-send.processor";

vi.mock("@trading-copilot/database", () => ({
  notificationDeliveriesRepository: {
    getById: vi.fn(),
    markNotificationSending: vi.fn(),
    markNotificationSent: vi.fn(),
    markNotificationFailed: vi.fn(),
    markNotificationRetrying: vi.fn(),
  },
  setupsRepository: {
    getSetup: vi.fn(),
  },
  instrumentsRepository: {
    getInstrument: vi.fn(),
  },
  strategiesRepository: {
    getStrategyWithVersions: vi.fn(),
    getStrategyVersion: vi.fn(),
  },
  marketSnapshotsRepository: {
    getMarketSnapshot: vi.fn(),
  },
  riskCalculationsRepository: {
    getLatestRiskCalculation: vi.fn(),
  },
  tradeScreenshotsRepository: {
    listScreenshotsForSetup: vi.fn(),
  },
}));

import {
  instrumentsRepository,
  marketSnapshotsRepository,
  notificationDeliveriesRepository,
  riskCalculationsRepository,
  setupsRepository,
  strategiesRepository,
  tradeScreenshotsRepository,
} from "@trading-copilot/database";

const SETUP_ID = "11111111-1111-1111-1111-111111111111";
const NOTIFICATION_ID = "22222222-2222-2222-2222-222222222222";

function buildSetup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SETUP_ID,
    instrumentId: "instrument-1",
    strategyId: "strategy-1",
    strategyVersionId: "strategy-version-1",
    marketSnapshotId: "snapshot-1",
    direction: "LONG",
    source: "SYSTEM",
    plannedEntry: new Decimal("100.00"),
    plannedStop: new Decimal("95.00"),
    plannedTarget1: new Decimal("110.00"),
    plannedTarget2: null,
    status: "READY",
    decisionSummary: null,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    sourceWebhookEventId: null,
    ...overrides,
  };
}

function buildNotification(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTIFICATION_ID,
    setupId: SETUP_ID,
    tradeId: null,
    tradeSource: null,
    provider: "CONSOLE",
    notificationType: "SETUP_READY",
    templateVersion: "1.0.0",
    status: "QUEUED",
    attemptCount: 0,
    queuedAt: new Date("2026-01-01T00:00:00Z"),
    sendingAt: null,
    sentAt: null,
    externalMessageId: null,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function mockCommonSetupContext() {
  vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup() as never);
  vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue({ symbol: "ES", name: "E-mini S&P" } as never);
  vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
  vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
  vi.mocked(marketSnapshotsRepository.getMarketSnapshot).mockResolvedValue({ timeframe: "5m" } as never);
  vi.mocked(riskCalculationsRepository.getLatestRiskCalculation).mockResolvedValue(null);
}

function buildProcessor(provider = { send: vi.fn() }, storage = { save: vi.fn(), read: vi.fn(), exists: vi.fn(), delete: vi.fn() }) {
  const processor = new NotificationSendProcessor(provider as never, storage as never);
  return { processor, provider, storage };
}

function buildJob(
  notificationDeliveryId = NOTIFICATION_ID,
  attempts: { attemptsMade: number; maxAttempts: number } = { attemptsMade: 1, maxAttempts: 5 },
) {
  return {
    data: { notificationDeliveryId },
    attemptsMade: attempts.attemptsMade,
    opts: { attempts: attempts.maxAttempts },
  } as never;
}

describe("NotificationSendProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(notificationDeliveriesRepository.markNotificationSending).mockResolvedValue({} as never);
    vi.mocked(notificationDeliveriesRepository.markNotificationSent).mockResolvedValue({} as never);
    vi.mocked(notificationDeliveriesRepository.markNotificationFailed).mockResolvedValue({} as never);
    vi.mocked(notificationDeliveriesRepository.markNotificationRetrying).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends with the PRE_TRADE screenshot attached when it is already READY", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(buildNotification() as never);
    mockCommonSetupContext();
    vi.mocked(tradeScreenshotsRepository.listScreenshotsForSetup).mockResolvedValue([
      { type: "PRE_TRADE", status: "READY", storageKey: "setups/s-1/pre-trade/1.0.0.png" },
    ] as never);
    const { processor, provider, storage } = buildProcessor();
    vi.mocked(storage.read).mockResolvedValue(Buffer.from("png-bytes"));
    vi.mocked(provider.send).mockResolvedValue({ externalMessageId: "msg-1" });

    await processor.process(buildJob());

    expect(storage.read).toHaveBeenCalledWith("setups/s-1/pre-trade/1.0.0.png");
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ imageBuffer: Buffer.from("png-bytes") }),
    );
    // No polling sleep was needed - the screenshot was already READY on the
    // very first lookup.
    expect(tradeScreenshotsRepository.listScreenshotsForSetup).toHaveBeenCalledTimes(1);
  });

  it("sends text-only after the bounded wait elapses with no READY screenshot", async () => {
    vi.useFakeTimers();
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(buildNotification() as never);
    mockCommonSetupContext();
    vi.mocked(tradeScreenshotsRepository.listScreenshotsForSetup).mockResolvedValue([] as never);
    const { processor, provider } = buildProcessor();
    vi.mocked(provider.send).mockResolvedValue({ externalMessageId: "msg-1" });

    const resultPromise = processor.process(buildJob());
    await vi.advanceTimersByTimeAsync(NOTIFICATION_SCREENSHOT_WAIT_MS + 1_000);
    await resultPromise;

    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ imageBuffer: null }));
  });

  it("marks the notification SENT with the provider's externalMessageId on success", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(
      buildNotification({ notificationType: "SETUP_PREPARE" }) as never,
    );
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup({ status: "PREPARE" }) as never);
    vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue({ symbol: "ES" } as never);
    vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
    vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
    const { processor, provider } = buildProcessor();
    vi.mocked(provider.send).mockResolvedValue({ externalMessageId: "telegram-42" });

    await processor.process(buildJob());

    expect(notificationDeliveriesRepository.markNotificationSending).toHaveBeenCalledWith(NOTIFICATION_ID);
    expect(notificationDeliveriesRepository.markNotificationSent).toHaveBeenCalledWith(NOTIFICATION_ID, {
      externalMessageId: "telegram-42",
    });
  });

  it("on a TEMPORARY provider error, marks the notification RETRYING and rethrows (letting BullMQ retry)", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(
      buildNotification({ notificationType: "SETUP_PREPARE" }) as never,
    );
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup({ status: "PREPARE" }) as never);
    vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue({ symbol: "ES" } as never);
    vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
    vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
    const { processor, provider } = buildProcessor();
    const temporaryError = new NotificationProviderError("rate limited", "TEMPORARY", "RATE_LIMITED");
    vi.mocked(provider.send).mockRejectedValue(temporaryError);

    await expect(processor.process(buildJob())).rejects.toThrow(temporaryError);

    expect(notificationDeliveriesRepository.markNotificationRetrying).toHaveBeenCalledWith(NOTIFICATION_ID, {
      failureCode: "RATE_LIMITED",
      failureMessage: "rate limited",
    });
    expect(notificationDeliveriesRepository.markNotificationFailed).not.toHaveBeenCalled();
  });

  it("on a TEMPORARY provider error on BullMQ's last configured attempt, marks the notification FAILED (RETRY_ATTEMPTS_EXHAUSTED) and does NOT rethrow (job resolves cleanly)", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(
      buildNotification({ notificationType: "SETUP_PREPARE" }) as never,
    );
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup({ status: "PREPARE" }) as never);
    vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue({ symbol: "ES" } as never);
    vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
    vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
    const { processor, provider } = buildProcessor();
    const temporaryError = new NotificationProviderError("rate limited", "TEMPORARY", "RATE_LIMITED");
    vi.mocked(provider.send).mockRejectedValue(temporaryError);

    // attemptsMade (5) >= opts.attempts (5): this is the last attempt BullMQ
    // will make.
    const job = buildJob(NOTIFICATION_ID, { attemptsMade: 5, maxAttempts: 5 });

    await expect(processor.process(job)).resolves.toBeUndefined();

    expect(notificationDeliveriesRepository.markNotificationFailed).toHaveBeenCalledWith(NOTIFICATION_ID, {
      failureCode: "RETRY_ATTEMPTS_EXHAUSTED",
      failureMessage: expect.stringContaining("rate limited"),
    });
    expect(notificationDeliveriesRepository.markNotificationRetrying).not.toHaveBeenCalled();
  });

  it("on a TEMPORARY provider error when attemptsMade is still below the configured ceiling, keeps the existing RETRYING+rethrow behavior unchanged", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(
      buildNotification({ notificationType: "SETUP_PREPARE" }) as never,
    );
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup({ status: "PREPARE" }) as never);
    vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue({ symbol: "ES" } as never);
    vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
    vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
    const { processor, provider } = buildProcessor();
    const temporaryError = new NotificationProviderError("rate limited", "TEMPORARY", "RATE_LIMITED");
    vi.mocked(provider.send).mockRejectedValue(temporaryError);

    // attemptsMade (4) < opts.attempts (5): BullMQ will still make another
    // attempt after this one.
    const job = buildJob(NOTIFICATION_ID, { attemptsMade: 4, maxAttempts: 5 });

    await expect(processor.process(job)).rejects.toThrow(temporaryError);

    expect(notificationDeliveriesRepository.markNotificationRetrying).toHaveBeenCalledWith(NOTIFICATION_ID, {
      failureCode: "RATE_LIMITED",
      failureMessage: "rate limited",
    });
    expect(notificationDeliveriesRepository.markNotificationFailed).not.toHaveBeenCalled();
  });

  it("on a PERMANENT provider error, marks the notification FAILED and does NOT rethrow (job completes, no further BullMQ retry)", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(
      buildNotification({ notificationType: "SETUP_PREPARE" }) as never,
    );
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup({ status: "PREPARE" }) as never);
    vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue({ symbol: "ES" } as never);
    vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
    vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
    const { processor, provider } = buildProcessor();
    const permanentError = new NotificationProviderError("invalid bot token", "PERMANENT", "INVALID_TOKEN");
    vi.mocked(provider.send).mockRejectedValue(permanentError);

    await expect(processor.process(buildJob())).resolves.toBeUndefined();

    expect(notificationDeliveriesRepository.markNotificationFailed).toHaveBeenCalledWith(NOTIFICATION_ID, {
      failureCode: "INVALID_TOKEN",
      failureMessage: "invalid bot token",
    });
    expect(notificationDeliveriesRepository.markNotificationRetrying).not.toHaveBeenCalled();
  });

  it("marks the notification FAILED with SETUP_CONTEXT_NOT_FOUND (without rethrowing) when a Setup-context lookup fails", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(
      buildNotification({ notificationType: "SETUP_PREPARE" }) as never,
    );
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(buildSetup({ status: "PREPARE" }) as never);
    vi.mocked(instrumentsRepository.getInstrument).mockResolvedValue(null as never);
    vi.mocked(strategiesRepository.getStrategyWithVersions).mockResolvedValue({ name: "Breakout" } as never);
    vi.mocked(strategiesRepository.getStrategyVersion).mockResolvedValue({ version: "1.0.0" } as never);
    const { processor, provider } = buildProcessor();

    await expect(processor.process(buildJob())).resolves.toBeUndefined();

    expect(provider.send).not.toHaveBeenCalled();
    expect(notificationDeliveriesRepository.markNotificationFailed).toHaveBeenCalledWith(NOTIFICATION_ID, {
      failureCode: "SETUP_CONTEXT_NOT_FOUND",
      failureMessage: expect.stringContaining(SETUP_ID),
    });
    expect(notificationDeliveriesRepository.markNotificationRetrying).not.toHaveBeenCalled();
  });

  it("marks the notification FAILED (without rethrowing) when its Setup no longer resolves", async () => {
    vi.mocked(notificationDeliveriesRepository.getById).mockResolvedValue(buildNotification() as never);
    vi.mocked(setupsRepository.getSetup).mockResolvedValue(null as never);
    const { processor, provider } = buildProcessor();

    await expect(processor.process(buildJob())).resolves.toBeUndefined();

    expect(provider.send).not.toHaveBeenCalled();
    expect(notificationDeliveriesRepository.markNotificationFailed).toHaveBeenCalledWith(NOTIFICATION_ID, {
      failureCode: "SETUP_NOT_FOUND",
      failureMessage: expect.stringContaining(SETUP_ID),
    });
  });
});
