import type Decimal from "decimal.js";
import type {
  AssetClass,
  BacktestStatus,
  Direction,
  StrategyVersionStatus,
  Timeframe,
  TradeExitReason,
} from "@trading-copilot/shared-types";

/**
 * Plain domain entities for Milestone 1, decoupled from Prisma's generated
 * types. packages/strategy-engine, packages/backtester, and
 * packages/risk-engine depend on these, not on @prisma/client — domain logic
 * must never depend on the ORM (see docs/architecture.md).
 *
 * All money/price/quantity fields use Decimal, never number, to avoid
 * floating-point error in financial arithmetic.
 */

export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  tickSize: Decimal;
  tickValue: Decimal;
  pointValue: Decimal;
  commissionPerContract: Decimal;
  timezone: string;
  sessionConfiguration: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Candle {
  id: string;
  instrumentId: string;
  timeframe: Timeframe;
  timestamp: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export interface Strategy {
  id: string;
  key: string;
  name: string;
  description: string;
  createdAt: Date;
}

/**
 * Parameters are validated against a Zod schema specific to the strategy
 * (see packages/strategy-engine) before a StrategyVersion is ever executed.
 * Once created, a StrategyVersion's parameters must never be mutated —
 * changes always create a new version row.
 */
export interface StrategyVersion<TParameters = Record<string, unknown>> {
  id: string;
  strategyId: string;
  version: string;
  name: string;
  description: string;
  parameters: TParameters;
  status: StrategyVersionStatus;
  createdAt: Date;
}

export interface BacktestAssumptions {
  commissionPerContract: string;
  slippageTicks: number;
  riskPercentage: string;
  initialBalance: string;
}

export interface Backtest {
  id: string;
  strategyVersionId: string;
  instrumentId: string;
  timeframe: Timeframe;
  startDate: Date;
  endDate: Date;
  status: BacktestStatus;
  assumptions: BacktestAssumptions;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface BacktestTrade {
  id: string;
  backtestId: string;
  strategyVersionId: string;
  instrumentId: string;
  direction: Direction;

  signalTimestamp: Date;

  entryTimestamp: Date;
  entryPrice: Decimal;

  stopPrice: Decimal;
  targetPrice: Decimal;

  exitTimestamp: Date;
  exitPrice: Decimal;

  entryReason: string;
  exitReason: TradeExitReason;

  quantity: number;

  grossPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;

  riskAmount: Decimal;
  rMultiple: Decimal;

  maximumFavorableExcursion: Decimal;
  maximumAdverseExcursion: Decimal;
}

export interface BacktestMetrics {
  id: string;
  backtestId: string;

  totalTrades: number;
  winningTrades: number;
  losingTrades: number;

  winRate: Decimal;

  grossProfit: Decimal;
  grossLoss: Decimal;
  netProfit: Decimal;

  profitFactor: Decimal | null;

  averageTrade: Decimal;
  averageR: Decimal;

  largestWin: Decimal;
  largestLoss: Decimal;

  averageWin: Decimal;
  averageLoss: Decimal;

  maxDrawdown: Decimal;
  maxDrawdownPercent: Decimal;

  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;

  expectancy: Decimal;
}
