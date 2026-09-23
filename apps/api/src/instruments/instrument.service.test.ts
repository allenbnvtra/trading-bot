import { NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import type { Instrument } from "@trading-copilot/trading-domain";
import { InstrumentService } from "./instrument.service";

const { instrumentsRepository } = vi.hoisted(() => ({
  instrumentsRepository: {
    listInstruments: vi.fn(),
    createInstrument: vi.fn(),
    getInstrument: vi.fn(),
  },
}));

vi.mock("@trading-copilot/database", async () => {
  const actual = await vi.importActual<typeof import("@trading-copilot/database")>(
    "@trading-copilot/database",
  );
  return {
    ...actual,
    instrumentsRepository,
  };
});

function makeInstrument(): Instrument {
  return {
    id: "instrument-1",
    symbol: "GENFUT1",
    name: "Generic Future",
    assetClass: "FUTURES",
    exchange: "SIM-FUT",
    currency: "USD",
    tickSize: new Decimal("0.25"),
    tickValue: new Decimal("12.5"),
    pointValue: new Decimal("50"),
    commissionPerContract: new Decimal("2.5"),
    timezone: "UTC",
    sessionConfiguration: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("InstrumentService.getById", () => {
  it("returns the instrument when found", async () => {
    const instrument = makeInstrument();
    instrumentsRepository.getInstrument.mockResolvedValue(instrument);

    const service = new InstrumentService();
    await expect(service.getById("instrument-1")).resolves.toBe(instrument);
  });

  it("throws NotFoundException when the instrument does not exist", async () => {
    instrumentsRepository.getInstrument.mockResolvedValue(null);

    const service = new InstrumentService();
    await expect(service.getById("missing-id")).rejects.toThrow(NotFoundException);
  });
});
