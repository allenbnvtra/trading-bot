import { NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketSnapshotService } from "./market-snapshot.service";

const { marketSnapshotsRepository } = vi.hoisted(() => ({
  marketSnapshotsRepository: {
    createMarketSnapshot: vi.fn(),
    listMarketSnapshots: vi.fn(),
    getMarketSnapshot: vi.fn(),
  },
}));

vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>(
    "@trading-copilot/database",
  );
  return { ...actual, marketSnapshotsRepository };
});

describe("MarketSnapshotService", () => {
  let service: MarketSnapshotService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MarketSnapshotService();
  });

  describe("getById", () => {
    it("404s when the snapshot does not exist", async () => {
      marketSnapshotsRepository.getMarketSnapshot.mockResolvedValue(null);
      await expect(service.getById("missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the snapshot when found", async () => {
      const snapshot = { id: "snapshot-1" };
      marketSnapshotsRepository.getMarketSnapshot.mockResolvedValue(snapshot);
      await expect(service.getById("snapshot-1")).resolves.toBe(snapshot);
    });
  });

  describe("create", () => {
    it("converts decimal-string and ISO-datetime fields, defaulting unset optional fields to null", async () => {
      marketSnapshotsRepository.createMarketSnapshot.mockResolvedValue({ id: "snapshot-1" });

      await service.create({
        instrumentId: "instrument-1",
        timestamp: "2024-01-01T00:00:00.000Z",
        timeframe: "1h",
        atr: "1.5",
        metadata: {},
      });

      const [input] = marketSnapshotsRepository.createMarketSnapshot.mock.calls[0]!;
      expect(input.instrumentId).toBe("instrument-1");
      expect(input.timestamp).toBeInstanceOf(Date);
      expect(input.atr).toBeInstanceOf(Decimal);
      expect(input.atr.toString()).toBe("1.5");
      expect(input.atrPercentile).toBeNull();
      expect(input.windowStartTimestamp).toBeNull();
      expect(input.trend1m).toBeNull();
    });
  });

  describe("list", () => {
    it("converts dateFrom/dateTo query strings to Date", async () => {
      marketSnapshotsRepository.listMarketSnapshots.mockResolvedValue([]);

      await service.list({
        instrumentId: "instrument-1",
        dateFrom: "2024-01-01T00:00:00.000Z",
        dateTo: "2024-02-01T00:00:00.000Z",
      });

      expect(marketSnapshotsRepository.listMarketSnapshots).toHaveBeenCalledWith({
        instrumentId: "instrument-1",
        timeframe: undefined,
        dateFrom: new Date("2024-01-01T00:00:00.000Z"),
        dateTo: new Date("2024-02-01T00:00:00.000Z"),
      });
    });
  });
});
