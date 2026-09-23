import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import type { Instrument } from "@trading-copilot/trading-domain";
import { InstrumentController } from "./instrument.controller";
import { InstrumentService } from "./instrument.service";

describe("InstrumentController", () => {
  it("delegates listing to InstrumentService", async () => {
    const instruments = [{ id: "1" } as Instrument];
    const instrumentService = { list: vi.fn().mockResolvedValue(instruments), create: vi.fn(), getById: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [InstrumentController],
      providers: [{ provide: InstrumentService, useValue: instrumentService }],
    }).compile();

    const controller = moduleRef.get(InstrumentController);
    await expect(controller.list()).resolves.toBe(instruments);
    expect(instrumentService.list).toHaveBeenCalledOnce();
  });

  it("delegates creation to InstrumentService with the validated body", async () => {
    const created = { id: "2" } as Instrument;
    const instrumentService = { list: vi.fn(), create: vi.fn().mockResolvedValue(created), getById: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [InstrumentController],
      providers: [{ provide: InstrumentService, useValue: instrumentService }],
    }).compile();

    const controller = moduleRef.get(InstrumentController);
    const body = {
      symbol: "GENFUT1",
      name: "Generic Future",
      assetClass: "FUTURES" as const,
      exchange: "SIM-FUT",
      currency: "USD",
      tickSize: "0.25",
      tickValue: "12.5",
      pointValue: "50",
      commissionPerContract: "2.5",
      timezone: "UTC",
      sessionConfiguration: {},
    };

    await expect(controller.create(body)).resolves.toBe(created);
    expect(instrumentService.create).toHaveBeenCalledWith(body);
  });

  it("delegates getById to InstrumentService with the path param", async () => {
    const instrument = { id: "3" } as Instrument;
    const instrumentService = {
      list: vi.fn(),
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue(instrument),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [InstrumentController],
      providers: [{ provide: InstrumentService, useValue: instrumentService }],
    }).compile();

    const controller = moduleRef.get(InstrumentController);
    await expect(controller.getById("3")).resolves.toBe(instrument);
    expect(instrumentService.getById).toHaveBeenCalledWith("3");
  });
});
