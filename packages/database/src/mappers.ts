import { Decimal } from "decimal.js";
import type {
  Backtest,
  BacktestAssumptions,
  BacktestMetrics,
  BacktestTrade,
  Candle,
  Instrument,
  Strategy,
  StrategyVersion,
} from "@trading-copilot/trading-domain";
import type {
  AssetClass,
  BacktestStatus,
  Direction,
  StrategyVersionStatus,
  Timeframe,
  TradeExitReason,
} from "@trading-copilot/shared-types";

/**
 * Pure Prisma-row -> trading-domain mappers (plus a couple of reverse
 * helpers for input shaping). Kept free of any real `@prisma/client`
 * import so these are trivially unit-testable with plain object fixtures —
 * the row interfaces below only declare the shape the mappers actually
 * read, and Prisma's generated model types satisfy them structurally.
 */

/**
 * Anything decimal.js's `Decimal` constructor can consume via `.toString()`:
 * a Prisma `Decimal`, a decimal.js `Decimal`, a plain numeric string, or a
 * number. Lets tests use plain string fixtures instead of real Prisma
 * Decimal instances.
 */
type Decimalish = string | number | { toString(): string };

function toDomainDecimal(value: Decimalish): Decimal {
  return new Decimal(value.toString());
}

function toNullableDomainDecimal(value: Decimalish | null): Decimal | null {
  return value === null ? null : toDomainDecimal(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Instrument
// ---------------------------------------------------------------------------

export interface PrismaInstrumentRow {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  tickSize: Decimalish;
  tickValue: Decimalish;
  pointValue: Decimalish;
  commissionPerContract: Decimalish;
  timezone: string;
  sessionConfiguration: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export function mapInstrument(row: PrismaInstrumentRow): Instrument {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetClass: row.assetClass,
    exchange: row.exchange,
    currency: row.currency,
    tickSize: toDomainDecimal(row.tickSize),
    tickValue: toDomainDecimal(row.tickValue),
    pointValue: toDomainDecimal(row.pointValue),
    commissionPerContract: toDomainDecimal(row.commissionPerContract),
    timezone: row.timezone,
    sessionConfiguration: toRecord(row.sessionConfiguration),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Candle
// ---------------------------------------------------------------------------

export interface PrismaCandleRow {
  id: string;
  instrumentId: string;
  // Stored as a plain string in Postgres (see schema.prisma); trusted to be
  // a valid Timeframe because src/candle-importer.ts validates it against
  // TIMEFRAMES before any row is ever written.
  timeframe: string;
  timestamp: Date;
  open: Decimalish;
  high: Decimalish;
  low: Decimalish;
  close: Decimalish;
  volume: Decimalish;
}

export function mapCandle(row: PrismaCandleRow): Candle {
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    timeframe: row.timeframe as Timeframe,
    timestamp: row.timestamp,
    open: toDomainDecimal(row.open),
    high: toDomainDecimal(row.high),
    low: toDomainDecimal(row.low),
    close: toDomainDecimal(row.close),
    volume: toDomainDecimal(row.volume),
  };
}

// ---------------------------------------------------------------------------
// Strategy / StrategyVersion
// ---------------------------------------------------------------------------

export interface PrismaStrategyRow {
  id: string;
  key: string;
  name: string;
  description: string;
  createdAt: Date;
}

export function mapStrategy(row: PrismaStrategyRow): Strategy {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
  };
}

export interface PrismaStrategyVersionRow {
  id: string;
  strategyId: string;
  version: string;
  name: string;
  description: string;
  parameters: unknown;
  status: StrategyVersionStatus;
  createdAt: Date;
}

/**
 * `TParameters` is not runtime-validated here — the database layer has no
 * knowledge of which strategy's parameter schema applies to a given row.
 * Callers (packages/strategy-engine) must re-validate `parameters` against
 * the strategy-specific Zod schema before using it.
 */
export function mapStrategyVersion<TParameters = Record<string, unknown>>(
  row: PrismaStrategyVersionRow,
): StrategyVersion<TParameters> {
  return {
    id: row.id,
    strategyId: row.strategyId,
    version: row.version,
    name: row.name,
    description: row.description,
    parameters: row.parameters as TParameters,
    status: row.status,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

export interface PrismaBacktestRow {
  id: string;
  strategyVersionId: string;
  instrumentId: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  status: BacktestStatus;
  assumptions: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

function toBacktestAssumptions(value: unknown): BacktestAssumptions {
  const record = toRecord(value);
  const { commissionPerContract, slippageTicks, riskPercentage, initialBalance } = record;
  if (
    typeof commissionPerContract !== "string" ||
    typeof slippageTicks !== "number" ||
    typeof riskPercentage !== "string" ||
    typeof initialBalance !== "string"
  ) {
    throw new Error("Malformed BacktestAssumptions JSON on Backtest row: " + JSON.stringify(value));
  }
  return { commissionPerContract, slippageTicks, riskPercentage, initialBalance };
}

/** Reverse helper: domain BacktestAssumptions -> a plain JSON-safe object for Prisma's `assumptions` Json column. */
export function backtestAssumptionsToJson(assumptions: BacktestAssumptions): Record<string, unknown> {
  return {
    commissionPerContract: assumptions.commissionPerContract,
    slippageTicks: assumptions.slippageTicks,
    riskPercentage: assumptions.riskPercentage,
    initialBalance: assumptions.initialBalance,
  };
}

export function mapBacktest(row: PrismaBacktestRow): Backtest {
  return {
    id: row.id,
    strategyVersionId: row.strategyVersionId,
    instrumentId: row.instrumentId,
    timeframe: row.timeframe as Timeframe,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    assumptions: toBacktestAssumptions(row.assumptions),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// BacktestTrade
// ---------------------------------------------------------------------------

export interface PrismaBacktestTradeRow {
  id: string;
  backtestId: string;
  strategyVersionId: string;
  instrumentId: string;
  direction: Direction;
  signalTimestamp: Date;
  entryTimestamp: Date;
  entryPrice: Decimalish;
  stopPrice: Decimalish;
  targetPrice: Decimalish;
  exitTimestamp: Date;
  exitPrice: Decimalish;
  entryReason: string;
  exitReason: TradeExitReason;
  quantity: number;
  grossPnl: Decimalish;
  fees: Decimalish;
  netPnl: Decimalish;
  riskAmount: Decimalish;
  rMultiple: Decimalish;
  maximumFavorableExcursion: Decimalish;
  maximumAdverseExcursion: Decimalish;
}

export function mapBacktestTrade(row: PrismaBacktestTradeRow): BacktestTrade {
  return {
    id: row.id,
    backtestId: row.backtestId,
    strategyVersionId: row.strategyVersionId,
    instrumentId: row.instrumentId,
    direction: row.direction,
    signalTimestamp: row.signalTimestamp,
    entryTimestamp: row.entryTimestamp,
    entryPrice: toDomainDecimal(row.entryPrice),
    stopPrice: toDomainDecimal(row.stopPrice),
    targetPrice: toDomainDecimal(row.targetPrice),
    exitTimestamp: row.exitTimestamp,
    exitPrice: toDomainDecimal(row.exitPrice),
    entryReason: row.entryReason,
    exitReason: row.exitReason,
    quantity: row.quantity,
    grossPnl: toDomainDecimal(row.grossPnl),
    fees: toDomainDecimal(row.fees),
    netPnl: toDomainDecimal(row.netPnl),
    riskAmount: toDomainDecimal(row.riskAmount),
    rMultiple: toDomainDecimal(row.rMultiple),
    maximumFavorableExcursion: toDomainDecimal(row.maximumFavorableExcursion),
    maximumAdverseExcursion: toDomainDecimal(row.maximumAdverseExcursion),
  };
}

// ---------------------------------------------------------------------------
// BacktestMetrics
// ---------------------------------------------------------------------------

export interface PrismaBacktestMetricsRow {
  id: string;
  backtestId: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: Decimalish;
  grossProfit: Decimalish;
  grossLoss: Decimalish;
  netProfit: Decimalish;
  profitFactor: Decimalish | null;
  averageTrade: Decimalish;
  averageR: Decimalish;
  largestWin: Decimalish;
  largestLoss: Decimalish;
  averageWin: Decimalish;
  averageLoss: Decimalish;
  maxDrawdown: Decimalish;
  maxDrawdownPercent: Decimalish;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  expectancy: Decimalish;
}

export function mapBacktestMetrics(row: PrismaBacktestMetricsRow): BacktestMetrics {
  return {
    id: row.id,
    backtestId: row.backtestId,
    totalTrades: row.totalTrades,
    winningTrades: row.winningTrades,
    losingTrades: row.losingTrades,
    winRate: toDomainDecimal(row.winRate),
    grossProfit: toDomainDecimal(row.grossProfit),
    grossLoss: toDomainDecimal(row.grossLoss),
    netProfit: toDomainDecimal(row.netProfit),
    profitFactor: toNullableDomainDecimal(row.profitFactor),
    averageTrade: toDomainDecimal(row.averageTrade),
    averageR: toDomainDecimal(row.averageR),
    largestWin: toDomainDecimal(row.largestWin),
    largestLoss: toDomainDecimal(row.largestLoss),
    averageWin: toDomainDecimal(row.averageWin),
    averageLoss: toDomainDecimal(row.averageLoss),
    maxDrawdown: toDomainDecimal(row.maxDrawdown),
    maxDrawdownPercent: toDomainDecimal(row.maxDrawdownPercent),
    maximumConsecutiveWins: row.maximumConsecutiveWins,
    maximumConsecutiveLosses: row.maximumConsecutiveLosses,
    expectancy: toDomainDecimal(row.expectancy),
  };
}
