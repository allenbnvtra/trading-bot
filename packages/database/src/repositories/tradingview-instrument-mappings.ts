import type { Instrument, TradingViewInstrumentMapping } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { mapInstrument, mapTradingViewInstrumentMapping } from "../mappers";

/**
 * Explicit exchange+symbol -> Instrument mapping (Milestone 3), see the
 * model-level comment on TradingViewInstrumentMapping in
 * prisma/schema.prisma. A webhook naming an unmapped symbol is rejected
 * (UNKNOWN_INSTRUMENT) by the caller (apps/worker); this module never
 * auto-creates an Instrument and never fuzzy-matches a symbol.
 *
 * `exchange`/`symbol` are normalized (trimmed + uppercased) both on create
 * and on resolve, so "cme"/"CME" and "nq1!"/"NQ1!" are treated as the same
 * mapping. This is plain case-normalization to prevent a trivial
 * case-mismatch footgun, not fuzzy matching.
 */
function normalize(value: string): string {
  return value.trim().toUpperCase();
}

export interface CreateTradingViewInstrumentMappingInput {
  exchange: string;
  symbol: string;
  instrumentId: string;
}

export async function createTradingViewInstrumentMapping(
  input: CreateTradingViewInstrumentMappingInput,
): Promise<TradingViewInstrumentMapping> {
  const row = await prisma.tradingViewInstrumentMapping.create({
    data: {
      exchange: normalize(input.exchange),
      symbol: normalize(input.symbol),
      instrumentId: input.instrumentId,
    },
  });
  return mapTradingViewInstrumentMapping(row);
}

/**
 * Returns the mapped Instrument directly, or null if no mapping exists. The
 * caller is responsible for treating null as UNKNOWN_INSTRUMENT and
 * rejecting the webhook, never guessing or auto-creating an Instrument.
 */
export async function resolveInstrumentMapping(
  exchange: string,
  symbol: string,
): Promise<Instrument | null> {
  const row = await prisma.tradingViewInstrumentMapping.findUnique({
    where: {
      exchange_symbol: { exchange: normalize(exchange), symbol: normalize(symbol) },
    },
    include: { instrument: true },
  });
  return row ? mapInstrument(row.instrument) : null;
}

export async function listTradingViewInstrumentMappings(): Promise<TradingViewInstrumentMapping[]> {
  const rows = await prisma.tradingViewInstrumentMapping.findMany({
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapTradingViewInstrumentMapping);
}

export async function getTradingViewInstrumentMapping(
  id: string,
): Promise<TradingViewInstrumentMapping | null> {
  const row = await prisma.tradingViewInstrumentMapping.findUnique({ where: { id } });
  return row ? mapTradingViewInstrumentMapping(row) : null;
}
