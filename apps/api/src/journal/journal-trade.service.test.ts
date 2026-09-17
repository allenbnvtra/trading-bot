import { NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JournalTradeStateError, NotFoundError } from "@trading-copilot/database";
import { JournalTradeService } from "./journal-trade.service";

const { journalTradesRepository } = vi.hoisted(() => ({
  journalTradesRepository: {
    createJournalTrade: vi.fn(),
    listJournalTrades: vi.fn(),
    getJournalTrade: vi.fn(),
    recordJournalTradeEntry: vi.fn(),
    closeJournalTrade: vi.fn(),
  },
}));

vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>(
    "@trading-copilot/database",
  );
  return { ...actual, journalTradesRepository };
});

describe("JournalTradeService", () => {
  let service: JournalTradeService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new JournalTradeService();
  });

  describe("getById", () => {
    it("404s when the trade does not exist", async () => {
      journalTradesRepository.getJournalTrade.mockResolvedValue(null);
      await expect(service.getById("missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the trade when found", async () => {
      const trade = { id: "trade-1" };
      journalTradesRepository.getJournalTrade.mockResolvedValue(trade);
      await expect(service.getById("trade-1")).resolves.toBe(trade);
    });
  });

  describe("recordEntry", () => {
    it("propagates JournalTradeStateError from the repository", async () => {
      journalTradesRepository.recordJournalTradeEntry.mockRejectedValue(
        new JournalTradeStateError("record entry", "OPEN", "PLANNED"),
      );

      await expect(
        service.recordEntry("trade-1", {
          actualEntry: "100",
          entryTimestamp: "2024-01-01T00:00:00.000Z",
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(JournalTradeStateError);
    });

    it("propagates NotFoundError from the repository when the trade is missing", async () => {
      journalTradesRepository.recordJournalTradeEntry.mockRejectedValue(
        new NotFoundError("JournalTrade", "missing"),
      );

      await expect(
        service.recordEntry("missing", {
          actualEntry: "100",
          entryTimestamp: "2024-01-01T00:00:00.000Z",
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("converts decimal-string and ISO-datetime input to Decimal/Date", async () => {
      journalTradesRepository.recordJournalTradeEntry.mockResolvedValue({ id: "trade-1" });

      await service.recordEntry("trade-1", {
        actualEntry: "100.25",
        entryTimestamp: "2024-01-01T00:00:00.000Z",
        quantity: 3,
        estimatedFees: "1.5",
      });

      const [id, input] = journalTradesRepository.recordJournalTradeEntry.mock.calls[0]!;
      expect(id).toBe("trade-1");
      expect(input.actualEntry).toBeInstanceOf(Decimal);
      expect(input.actualEntry.toString()).toBe("100.25");
      expect(input.entryTimestamp).toBeInstanceOf(Date);
      expect(input.quantity).toBe(3);
      expect(input.estimatedFees.toString()).toBe("1.5");
      expect(input.estimatedSlippage).toBeNull();
    });
  });

  describe("close", () => {
    it("propagates JournalTradeStateError from the repository", async () => {
      journalTradesRepository.closeJournalTrade.mockRejectedValue(
        new JournalTradeStateError("close", "PLANNED", "OPEN"),
      );

      await expect(
        service.close("trade-1", { actualExit: "110", exitTimestamp: "2024-01-02T00:00:00.000Z" }),
      ).rejects.toBeInstanceOf(JournalTradeStateError);
    });
  });
});
