import { describe, expect, it, vi } from "vitest";
import { MarketDataService } from "./market-data.service";

const { candlesRepository } = vi.hoisted(() => ({
  candlesRepository: {
    getCandlesUpToTimestamp: vi.fn(),
  },
}));

vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>(
    "@trading-copilot/database",
  );
  return {
    ...actual,
    candlesRepository,
  };
});

describe("MarketDataService.getCandlesUpToTimestamp", () => {
  it("delegates to the cutoff-safe repository query, not getCandles", async () => {
    const spy = vi.spyOn(candlesRepository, "getCandlesUpToTimestamp").mockResolvedValue([]);
    const service = new MarketDataService();

    await service.getCandlesUpToTimestamp(
      "instrument-1",
      "5m",
      new Date("2026-09-18T01:30:00.000Z"),
      150,
    );

    expect(spy).toHaveBeenCalledWith(
      "instrument-1",
      "5m",
      new Date("2026-09-18T01:30:00.000Z"),
      150,
    );
  });
});
