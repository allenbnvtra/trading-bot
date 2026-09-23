import { ConflictException, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, SetupTransitionError } from "@trading-copilot/database";
import type { Setup } from "@trading-copilot/trading-domain";
import { SetupService } from "./setup.service";

const {
  setupsRepository,
  riskCalculationsRepository,
  journalEventsRepository,
  notificationDeliveriesRepository,
  journalTradesRepository,
} = vi.hoisted(() => ({
  setupsRepository: {
    createSetup: vi.fn(),
    listSetups: vi.fn(),
    getSetup: vi.fn(),
    transitionSetupStatus: vi.fn(),
  },
  riskCalculationsRepository: {
    createRiskCalculation: vi.fn(),
    listRiskCalculations: vi.fn(),
    getLatestRiskCalculation: vi.fn(),
  },
  journalEventsRepository: {
    getSetupTimeline: vi.fn(),
  },
  notificationDeliveriesRepository: {
    findMostRecentSentNotification: vi.fn(),
  },
  journalTradesRepository: {
    createAndRecordJournalTradeEntry: vi.fn(),
    createJournalTrade: vi.fn(),
    findOpenJournalTradeBySetupId: vi.fn(),
  },
}));

vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>(
    "@trading-copilot/database",
  );
  return {
    ...actual,
    setupsRepository,
    riskCalculationsRepository,
    journalEventsRepository,
    notificationDeliveriesRepository,
    journalTradesRepository,
  };
});

function makeSetup(overrides: Partial<Setup> = {}): Setup {
  return {
    id: "setup-1",
    instrumentId: "instrument-1",
    strategyId: "strategy-1",
    strategyVersionId: "strategy-version-1",
    marketSnapshotId: "snapshot-1",
    direction: "LONG",
    source: "MANUAL_TEST",
    plannedEntry: new Decimal("100"),
    plannedStop: new Decimal("95"),
    plannedTarget1: new Decimal("110"),
    plannedTarget2: null,
    status: "WATCH",
    decisionSummary: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
    sourceWebhookEventId: null,
    ...overrides,
  };
}

describe("SetupService", () => {
  let service: SetupService;
  let screenshotService: { requestPreTradeScreenshot: ReturnType<typeof vi.fn> };
  let notificationService: { requestNotification: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    screenshotService = { requestPreTradeScreenshot: vi.fn().mockResolvedValue({}) };
    notificationService = { requestNotification: vi.fn().mockResolvedValue(undefined) };
    service = new SetupService(screenshotService as never, notificationService as never);
    journalTradesRepository.findOpenJournalTradeBySetupId.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getById", () => {
    it("throws NotFoundException when the setup does not exist", async () => {
      setupsRepository.getSetup.mockResolvedValue(null);
      await expect(service.getById("missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the setup when found", async () => {
      const setup = makeSetup();
      setupsRepository.getSetup.mockResolvedValue(setup);
      await expect(service.getById(setup.id)).resolves.toBe(setup);
    });
  });

  describe("updateStatus", () => {
    it("propagates SetupTransitionError from the repository (translated by the global filter)", async () => {
      setupsRepository.transitionSetupStatus.mockRejectedValue(
        new SetupTransitionError("REJECTED", "READY"),
      );
      await expect(service.updateStatus("setup-1", { status: "READY" })).rejects.toBeInstanceOf(
        SetupTransitionError,
      );
    });

    it("propagates NotFoundError from the repository when the setup is missing", async () => {
      setupsRepository.transitionSetupStatus.mockRejectedValue(new NotFoundError("Setup", "missing"));
      await expect(service.updateStatus("missing", { status: "READY" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("passes the validated status/decisionSummary straight through", async () => {
      const setup = makeSetup({ status: "READY" });
      setupsRepository.transitionSetupStatus.mockResolvedValue(setup);

      await service.updateStatus("setup-1", { status: "READY", decisionSummary: "looks good" });

      expect(setupsRepository.transitionSetupStatus).toHaveBeenCalledWith("setup-1", {
        status: "READY",
        decisionSummary: "looks good",
      });
    });

    it("requests a PRE_TRADE screenshot when a Setup transitions to READY", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "READY" } as never);

      await service.updateStatus("setup-1", { status: "READY" });

      expect(screenshotService.requestPreTradeScreenshot).toHaveBeenCalledWith("setup-1");
    });

    it("does not request a screenshot for a non-READY transition", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "PREPARE" } as never);

      await service.updateStatus("setup-1", { status: "PREPARE" });

      expect(screenshotService.requestPreTradeScreenshot).not.toHaveBeenCalled();
    });

    it("does not let a screenshot-request failure fail the status transition itself", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "READY" } as never);
      screenshotService.requestPreTradeScreenshot.mockRejectedValue(new Error("queue down"));

      await expect(service.updateStatus("setup-1", { status: "READY" })).resolves.toMatchObject({
        status: "READY",
      });
    });
  });

  describe("updateStatus notification policy", () => {
    it("does not request a notification when transitioning to WATCH", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "WATCH" } as never);

      await service.updateStatus("setup-1", { status: "WATCH" });

      expect(notificationService.requestNotification).not.toHaveBeenCalled();
    });

    it("does not request a SETUP_PREPARE notification by default (NOTIFICATION_PREPARE_ENABLED unset)", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "PREPARE" } as never);

      await service.updateStatus("setup-1", { status: "PREPARE" });

      expect(notificationService.requestNotification).not.toHaveBeenCalled();
    });

    it("requests a SETUP_PREPARE notification when NOTIFICATION_PREPARE_ENABLED=true", async () => {
      vi.stubEnv("NOTIFICATION_PREPARE_ENABLED", "true");
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "PREPARE" } as never);

      await service.updateStatus("setup-1", { status: "PREPARE" });

      expect(notificationService.requestNotification).toHaveBeenCalledWith("setup-1", "SETUP_PREPARE");
    });

    it("requests a SETUP_READY notification when transitioning to READY", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "READY" } as never);

      await service.updateStatus("setup-1", { status: "READY" });

      expect(notificationService.requestNotification).toHaveBeenCalledWith("setup-1", "SETUP_READY");
    });

    it("requests a SETUP_INVALIDATED notification only if a SETUP_PREPARE or SETUP_READY notification was previously SENT", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "INVALIDATED" } as never);
      notificationDeliveriesRepository.findMostRecentSentNotification.mockResolvedValue(null);

      await service.updateStatus("setup-1", { status: "INVALIDATED" });

      expect(notificationDeliveriesRepository.findMostRecentSentNotification).toHaveBeenCalledWith("setup-1", [
        "SETUP_PREPARE",
        "SETUP_READY",
      ]);
      expect(notificationService.requestNotification).not.toHaveBeenCalled();

      notificationDeliveriesRepository.findMostRecentSentNotification.mockResolvedValue({
        id: "notification-1",
        status: "SENT",
      } as never);

      await service.updateStatus("setup-1", { status: "INVALIDATED" });

      expect(notificationService.requestNotification).toHaveBeenCalledWith("setup-1", "SETUP_INVALIDATED");
    });

    it("never fails the status transition when notification enqueueing throws", async () => {
      setupsRepository.transitionSetupStatus.mockResolvedValue({ id: "setup-1", status: "READY" } as never);
      notificationService.requestNotification.mockRejectedValue(new Error("queue down"));

      await expect(service.updateStatus("setup-1", { status: "READY" })).resolves.toMatchObject({
        status: "READY",
      });
    });
  });

  describe("getTimeline", () => {
    it("404s before querying the timeline when the setup does not exist", async () => {
      setupsRepository.getSetup.mockResolvedValue(null);
      await expect(service.getTimeline("missing")).rejects.toBeInstanceOf(NotFoundException);
      expect(journalEventsRepository.getSetupTimeline).not.toHaveBeenCalled();
    });

    it("returns the setup's timeline when it exists", async () => {
      const setup = makeSetup();
      setupsRepository.getSetup.mockResolvedValue(setup);
      journalEventsRepository.getSetupTimeline.mockResolvedValue(["event-a", "event-b"]);

      await expect(service.getTimeline(setup.id)).resolves.toEqual(["event-a", "event-b"]);
      expect(journalEventsRepository.getSetupTimeline).toHaveBeenCalledWith(setup.id);
    });
  });

  describe("createRiskCalculation", () => {
    it("converts decimal-string input to Decimal before calling the repository", async () => {
      riskCalculationsRepository.createRiskCalculation.mockResolvedValue({ id: "risk-1" });

      await service.createRiskCalculation("setup-1", {
        accountEquity: "10000",
        riskPercentage: "1",
        slippageTicks: 2,
      });

      const [setupId, input] = riskCalculationsRepository.createRiskCalculation.mock.calls[0]!;
      expect(setupId).toBe("setup-1");
      expect(input.accountEquity).toBeInstanceOf(Decimal);
      expect(input.accountEquity.toString()).toBe("10000");
      expect(input.riskPercentage.toString()).toBe("1");
      expect(input.slippageTicks).toBe(2);
    });
  });

  describe("getLatestRiskCalculation", () => {
    it("404s when no risk calculation exists yet", async () => {
      riskCalculationsRepository.getLatestRiskCalculation.mockResolvedValue(null);
      await expect(service.getLatestRiskCalculation("setup-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the latest risk calculation when one exists", async () => {
      const calculation = { id: "risk-1" };
      riskCalculationsRepository.getLatestRiskCalculation.mockResolvedValue(calculation);
      await expect(service.getLatestRiskCalculation("setup-1")).resolves.toBe(calculation);
    });
  });

  describe("execute", () => {
    it("creates and records an OPEN JournalTrade atomically from a Setup's own planned values", async () => {
      const setup = makeSetup({
        id: "setup-1",
        status: "READY",
        plannedEntry: new Decimal("100"),
        plannedStop: new Decimal("95"),
        plannedTarget1: new Decimal("110"),
        plannedTarget2: new Decimal("120"),
      });
      setupsRepository.getSetup.mockResolvedValue(setup);
      riskCalculationsRepository.getLatestRiskCalculation.mockResolvedValue(null);
      const created = { id: "trade-1" };
      journalTradesRepository.createAndRecordJournalTradeEntry.mockResolvedValue(created);

      const result = await service.execute("setup-1", {
        executionMode: "PAPER",
        actualEntry: "100.5",
        quantity: 2,
        entryTimestamp: "2026-09-23T00:00:00.000Z",
        actualFees: "1.5",
        actualSlippage: "0.25",
        notes: "filled quickly",
      });

      expect(result).toBe(created);
      expect(journalTradesRepository.createAndRecordJournalTradeEntry).toHaveBeenCalledTimes(1);
      const [input] = journalTradesRepository.createAndRecordJournalTradeEntry.mock.calls[0]!;
      expect(input.setupId).toBe("setup-1");
      expect(input.instrumentId).toBe(setup.instrumentId);
      expect(input.strategyId).toBe(setup.strategyId);
      expect(input.strategyVersionId).toBe(setup.strategyVersionId);
      expect(input.direction).toBe(setup.direction);
      expect(input.plannedEntry).toBe(setup.plannedEntry);
      expect(input.plannedStop).toBe(setup.plannedStop);
      expect(input.plannedTarget1).toBe(setup.plannedTarget1);
      expect(input.plannedTarget2).toBe(setup.plannedTarget2);
      expect(input.plannedRisk).toBeNull();
      expect(input.executionMode).toBe("PAPER");
      expect(input.actualEntry).toBeInstanceOf(Decimal);
      expect(input.actualEntry.toString()).toBe("100.5");
      expect(input.quantity).toBe(2);
      expect(input.entryTimestamp).toEqual(new Date("2026-09-23T00:00:00.000Z"));
      expect(input.actualFees.toString()).toBe("1.5");
      expect(input.actualSlippage.toString()).toBe("0.25");
      expect(input.notes).toBe("filled quickly");
    });

    it("falls back to plannedEntry when the Setup's plannedStop is null", async () => {
      const setup = makeSetup({ id: "setup-1", status: "READY", plannedEntry: new Decimal("100"), plannedStop: null });
      setupsRepository.getSetup.mockResolvedValue(setup);
      riskCalculationsRepository.getLatestRiskCalculation.mockResolvedValue(null);
      journalTradesRepository.createAndRecordJournalTradeEntry.mockResolvedValue({ id: "trade-1" });

      await service.execute("setup-1", {
        executionMode: "PAPER",
        actualEntry: "100.5",
        quantity: 1,
        entryTimestamp: "2026-09-23T00:00:00.000Z",
      });

      const [input] = journalTradesRepository.createAndRecordJournalTradeEntry.mock.calls[0]!;
      expect(input.plannedStop).toBe(setup.plannedEntry);
    });

    it("sources plannedRisk from the Setup's latest RiskCalculation's estimatedTotalRisk when one exists", async () => {
      const setup = makeSetup({ id: "setup-1", status: "READY" });
      setupsRepository.getSetup.mockResolvedValue(setup);
      riskCalculationsRepository.getLatestRiskCalculation.mockResolvedValue({
        id: "risk-1",
        estimatedTotalRisk: new Decimal("250"),
      });
      journalTradesRepository.createAndRecordJournalTradeEntry.mockResolvedValue({ id: "trade-1" });

      await service.execute("setup-1", {
        executionMode: "MANUAL_LIVE",
        actualEntry: "100.5",
        quantity: 1,
        entryTimestamp: "2026-09-23T00:00:00.000Z",
      });

      const [input] = journalTradesRepository.createAndRecordJournalTradeEntry.mock.calls[0]!;
      expect(input.plannedRisk).toBeInstanceOf(Decimal);
      expect(input.plannedRisk.toString()).toBe("250");
    });

    it("rejects execute for a Setup not in READY status", async () => {
      const setup = makeSetup({ id: "setup-1", status: "PREPARE" });
      setupsRepository.getSetup.mockResolvedValue(setup);

      await expect(
        service.execute("setup-1", {
          executionMode: "PAPER",
          actualEntry: "100.5",
          quantity: 1,
          entryTimestamp: "2026-09-23T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(journalTradesRepository.createAndRecordJournalTradeEntry).not.toHaveBeenCalled();
    });

    it("404s when the Setup does not exist", async () => {
      setupsRepository.getSetup.mockResolvedValue(null);

      await expect(
        service.execute("missing", {
          executionMode: "PAPER",
          actualEntry: "100.5",
          quantity: 1,
          entryTimestamp: "2026-09-23T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a second execute() call against a Setup that already has an OPEN JournalTrade (double-submit guard)", async () => {
      const setup = makeSetup({ id: "setup-1", status: "READY" });
      setupsRepository.getSetup.mockResolvedValue(setup);
      journalTradesRepository.findOpenJournalTradeBySetupId.mockResolvedValue({
        id: "trade-1",
        status: "OPEN",
      } as never);

      await expect(
        service.execute("setup-1", {
          executionMode: "PAPER",
          actualEntry: "100.5",
          quantity: 1,
          entryTimestamp: "2026-09-23T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(journalTradesRepository.findOpenJournalTradeBySetupId).toHaveBeenCalledWith("setup-1");
      expect(journalTradesRepository.createAndRecordJournalTradeEntry).not.toHaveBeenCalled();
    });

    it("still succeeds normally when no OPEN JournalTrade exists yet for the Setup (no false-positive rejection)", async () => {
      const setup = makeSetup({ id: "setup-1", status: "READY" });
      setupsRepository.getSetup.mockResolvedValue(setup);
      riskCalculationsRepository.getLatestRiskCalculation.mockResolvedValue(null);
      journalTradesRepository.findOpenJournalTradeBySetupId.mockResolvedValue(null);
      const created = { id: "trade-1" };
      journalTradesRepository.createAndRecordJournalTradeEntry.mockResolvedValue(created);

      const result = await service.execute("setup-1", {
        executionMode: "PAPER",
        actualEntry: "100.5",
        quantity: 1,
        entryTimestamp: "2026-09-23T00:00:00.000Z",
      });

      expect(result).toBe(created);
      expect(journalTradesRepository.findOpenJournalTradeBySetupId).toHaveBeenCalledWith("setup-1");
      expect(journalTradesRepository.createAndRecordJournalTradeEntry).toHaveBeenCalledTimes(1);
    });
  });

  describe("skip", () => {
    it("creates a SKIPPED JournalTrade with the given reason and preserves the Setup unmodified", async () => {
      const setup = makeSetup({ id: "setup-1", status: "READY" });
      setupsRepository.getSetup.mockResolvedValue(setup);
      const created = { id: "trade-1" };
      journalTradesRepository.createJournalTrade.mockResolvedValue(created);

      const result = await service.skip("setup-1", { reason: "PRICE_MOVED" });

      expect(result).toBe(created);
      expect(setupsRepository.transitionSetupStatus).not.toHaveBeenCalled();
      const [input] = journalTradesRepository.createJournalTrade.mock.calls[0]!;
      expect(input.setupId).toBe("setup-1");
      expect(input.executionMode).toBe("SKIPPED");
      expect(input.skipReason).toBe("PRICE_MOVED");
      expect(input.plannedRisk).toBeNull();
    });

    it("allows skip with no reason at all", async () => {
      const setup = makeSetup({ id: "setup-1", status: "READY" });
      setupsRepository.getSetup.mockResolvedValue(setup);
      journalTradesRepository.createJournalTrade.mockResolvedValue({ id: "trade-1" });

      await service.skip("setup-1", {});

      const [input] = journalTradesRepository.createJournalTrade.mock.calls[0]!;
      expect(input.skipReason).toBeNull();
    });

    it("404s when the Setup does not exist", async () => {
      setupsRepository.getSetup.mockResolvedValue(null);

      await expect(service.skip("missing", {})).rejects.toBeInstanceOf(NotFoundException);
      expect(journalTradesRepository.createJournalTrade).not.toHaveBeenCalled();
    });
  });
});
