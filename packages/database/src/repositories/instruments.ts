import type { Prisma } from "@prisma/client";
import type { CreateInstrumentInput } from "@trading-copilot/shared-types";
import type { Instrument } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapInstrument } from "../mappers";

export async function createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
  const row = await prisma.instrument.create({
    data: {
      symbol: input.symbol,
      name: input.name,
      assetClass: input.assetClass,
      exchange: input.exchange,
      currency: input.currency,
      tickSize: input.tickSize,
      tickValue: input.tickValue,
      pointValue: input.pointValue,
      commissionPerContract: input.commissionPerContract,
      timezone: input.timezone,
      sessionConfiguration: input.sessionConfiguration as Prisma.InputJsonValue,
    },
  });
  return mapInstrument(row);
}

export async function listInstruments(): Promise<Instrument[]> {
  const rows = await prisma.instrument.findMany({ orderBy: { symbol: "asc" } });
  return rows.map(mapInstrument);
}

export async function getInstrument(id: string): Promise<Instrument | null> {
  const row = await prisma.instrument.findUnique({ where: { id } });
  return row ? mapInstrument(row) : null;
}

export async function findInstrumentBySymbolAndExchange(
  symbol: string,
  exchange: string,
): Promise<Instrument | null> {
  const row = await prisma.instrument.findUnique({
    where: { symbol_exchange: { symbol, exchange } },
  });
  return row ? mapInstrument(row) : null;
}
