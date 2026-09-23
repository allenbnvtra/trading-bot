import { NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, SetupTransitionError } from "@trading-copilot/database";
import type { Setup } from "@trading-copilot/trading-domain";
import { SetupService } from "./setup.service";

const { setupsRepository, riskCalculationsRepository, journalEventsRepository } = vi.hoisted(() => ({
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

  beforeEach(() => {
    vi.clearAllMocks();
    screenshotService = { requestPreTradeScreenshot: vi.fn().mockResolvedValue({}) };
    service = new SetupService(screenshotService as never);
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
});
