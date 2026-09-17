/**
 * Thin fetch client for the Trading Copilot API.
 *
 * This module never computes financial values. Every field it returns is
 * exactly what the API sent (decimal fields stay as strings); formatting for
 * display happens in `lib/format.ts`.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export type AssetClass = "FUTURES" | "FOREX" | "CRYPTO" | "STOCK";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Direction = "LONG" | "SHORT";
export type ExitReason = "STOP" | "TARGET" | "SAME_CANDLE_STOP_AND_TARGET" | "END_OF_DATA";
export type BacktestStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type StrategyVersionStatus =
  | "DISCOVERED"
  | "BACKTESTING"
  | "VALIDATION"
  | "OUT_OF_SAMPLE"
  | "WALK_FORWARD"
  | "PAPER_TRADING"
  | "APPROVED"
  | "PAUSED"
  | "RETIRED";

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export interface HealthResponse {
  status: "ok" | "degraded";
  postgres: "up" | "down";
  redis: "up" | "down";
}

export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  tickSize: string;
  tickValue: string;
  pointValue: string;
  commissionPerContract: string;
  timezone: string;
  sessionConfiguration: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Strategy {
  id: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface StrategyVersion {
  id: string;
  strategyId: string;
  version: string;
  name: string;
  description: string | null;
  parameters: Record<string, unknown>;
  status: StrategyVersionStatus;
  createdAt: string;
}

export interface StrategyWithVersions extends Strategy {
  versions: StrategyVersion[];
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
  startDate: string;
  endDate: string;
  status: BacktestStatus;
  assumptions: BacktestAssumptions;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface BacktestMetrics {
  id: string;
  backtestId: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: string;
  grossProfit: string;
  grossLoss: string;
  netProfit: string;
  profitFactor: string | null;
  averageTrade: string;
  averageR: string;
  largestWin: string;
  largestLoss: string;
  averageWin: string;
  averageLoss: string;
  maxDrawdown: string;
  maxDrawdownPercent: string;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  expectancy: string;
}

export interface BacktestWithMetrics extends Backtest {
  metrics: BacktestMetrics | null;
}

export interface BacktestTrade {
  id: string;
  backtestId: string;
  strategyVersionId: string;
  instrumentId: string;
  direction: Direction;
  signalTimestamp: string;
  entryTimestamp: string;
  entryPrice: string;
  stopPrice: string;
  targetPrice: string;
  exitTimestamp: string;
  exitPrice: string;
  entryReason: string;
  exitReason: ExitReason;
  quantity: number;
  grossPnl: string;
  fees: string;
  netPnl: string;
  riskAmount: string;
  rMultiple: string;
  maximumFavorableExcursion: string;
  maximumAdverseExcursion: string;
}

export interface Candle {
  id: string;
  instrumentId: string;
  timeframe: Timeframe;
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface TradeDetail {
  trade: BacktestTrade;
  surroundingCandles: Candle[];
}

export interface CreateBacktestInput {
  instrumentId: string;
  strategyVersionId: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  initialBalance: string;
  riskPercentage: string;
  slippageTicks?: number;
}

export interface MarketDataImportResult {
  instrumentId: string;
  timeframe: string;
  rowsRead: number;
  inserted: number;
  updated: number;
  rejected: number;
  errors: { row: number; message: string }[];
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface NestErrorBody {
  statusCode?: number;
  message?: string | string[];
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, `Could not reach the API at ${API_BASE_URL}. Is it running?`);
  }

  if (!res.ok) {
    let message = res.statusText || `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as NestErrorBody;
      if (body.message) {
        message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
      }
    } catch {
      // response body was not JSON; keep the status text.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health");
}

export function getInstruments(): Promise<Instrument[]> {
  return apiFetch<Instrument[]>("/instruments");
}

export function getStrategies(): Promise<Strategy[]> {
  return apiFetch<Strategy[]>("/strategies");
}

export function getStrategy(id: string): Promise<StrategyWithVersions> {
  return apiFetch<StrategyWithVersions>(`/strategies/${id}`);
}

export function getBacktests(): Promise<Backtest[]> {
  return apiFetch<Backtest[]>("/backtests");
}

export function getBacktest(id: string): Promise<BacktestWithMetrics> {
  return apiFetch<BacktestWithMetrics>(`/backtests/${id}`);
}

export function getBacktestTrades(id: string): Promise<BacktestTrade[]> {
  return apiFetch<BacktestTrade[]>(`/backtests/${id}/trades`);
}

export function getBacktestTrade(backtestId: string, tradeId: string): Promise<TradeDetail> {
  return apiFetch<TradeDetail>(`/backtests/${backtestId}/trades/${tradeId}`);
}

export function createBacktest(input: CreateBacktestInput): Promise<Backtest> {
  return apiFetch<Backtest>("/backtests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function importMarketData(formData: FormData): Promise<MarketDataImportResult> {
  return apiFetch<MarketDataImportResult>("/market-data/import", {
    method: "POST",
    body: formData,
  });
}
