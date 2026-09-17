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

// --- Milestone 2: journal, setups, analytics ---------------------------

export type JournalEventType =
  | "SETUP_CREATED"
  | "STRATEGY_EVALUATED"
  | "RISK_CALCULATED"
  | "SETUP_APPROVED"
  | "SETUP_REJECTED"
  | "SETUP_INVALIDATED"
  | "SETUP_EXPIRED"
  | "TRADE_READY"
  | "TRADE_EXECUTED"
  | "TRADE_SKIPPED"
  | "TRADE_CLOSED"
  | "POST_TRADE_ANALYSIS_CREATED"
  | "STRATEGY_VERSION_PROPOSED";

export type JournalEntityType =
  | "SETUP"
  | "JOURNAL_TRADE"
  | "RISK_CALCULATION"
  | "MARKET_SNAPSHOT"
  | "BACKTEST"
  | "BACKTEST_TRADE"
  | "STRATEGY_VERSION"
  | "POST_TRADE_ANALYSIS";

export type SetupStatus = "WATCH" | "PREPARE" | "READY" | "REJECTED" | "INVALIDATED" | "EXPIRED";
export type SetupSource = "BACKTEST" | "MANUAL_TEST" | "SYSTEM";
export type ExecutionMode = "BACKTEST" | "PAPER" | "MANUAL_LIVE" | "SKIPPED";
export type JournalTradeStatus = "PLANNED" | "OPEN" | "CLOSED" | "SKIPPED";
export type NormalizedTradeSource = "BACKTEST" | "JOURNAL";

export interface JournalEvent {
  id: string;
  eventType: JournalEventType;
  timestamp: string;
  entityType: JournalEntityType;
  entityId: string;
  correlationId: string | null;
  instrumentId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  metadata: Record<string, unknown>;
}

export interface JournalEventFilters {
  entityType?: JournalEntityType;
  entityId?: string;
  correlationId?: string;
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface Setup {
  id: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  marketSnapshotId: string;
  direction: Direction;
  source: SetupSource;
  plannedEntry: string;
  plannedStop: string;
  plannedTarget1: string;
  plannedTarget2: string | null;
  status: SetupStatus;
  decisionSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface JournalTrade {
  id: string;
  setupId: string | null;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  plannedEntry: string;
  plannedStop: string;
  plannedTarget1: string | null;
  plannedTarget2: string | null;
  actualEntry: string | null;
  actualExit: string | null;
  entryTimestamp: string | null;
  exitTimestamp: string | null;
  quantity: number | null;
  plannedRisk: string | null;
  estimatedFees: string | null;
  actualFees: string | null;
  estimatedSlippage: string | null;
  actualSlippage: string | null;
  grossPnl: string | null;
  netPnl: string | null;
  rMultiple: string | null;
  mfe: string | null;
  mae: string | null;
  executionMode: ExecutionMode;
  status: JournalTradeStatus;
  entryNotes: string | null;
  exitNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalTradeFilters {
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  direction?: Direction;
  executionMode?: ExecutionMode;
  dateFrom?: string;
  dateTo?: string;
}

export interface TradeAnalyticsMetrics {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: string;
  grossProfit: string;
  grossLoss: string;
  netPnl: string;
  averagePnl: string;
  expectancy: string;
  averageR: string;
  profitFactor: string | null;
  averageWinner: string;
  averageLoser: string;
  largestWinner: string;
  largestLoser: string;
  maxDrawdown: string;
  maxDrawdownPercent: string | null;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  mfeAverage: string | null;
  maeAverage: string | null;
  totalFees: string;
  averageSlippage: string | null;
}

export interface StrategyGroupSummary {
  strategyId: string | null;
  strategyName: string | null;
  strategyVersionId: string | null;
  version: string | null;
  metrics: TradeAnalyticsMetrics;
}

export interface GroupComparisonStats {
  sampleSize: number;
  averageR: string;
  profitFactor: string | null;
  winRate: string;
}

export interface WinnerLoserComparison {
  winners: GroupComparisonStats;
  losers: GroupComparisonStats;
  allTrades: GroupComparisonStats;
}

export interface NormalizedTrade {
  source: NormalizedTradeSource;
  id: string;
  strategyId: string;
  strategyVersionId: string;
  instrumentId: string;
  direction: Direction;
  executionMode: ExecutionMode;
  entryTimestamp: string;
  exitTimestamp: string;
  entryPrice: string;
  exitPrice: string;
  quantity: number;
  grossPnl: string;
  fees: string;
  netPnl: string;
  riskAmount: string | null;
  rMultiple: string | null;
  mfe: string | null;
  mae: string | null;
  slippage: string | null;
}

export interface StrategyVersionAnalyticsDetail {
  metrics: TradeAnalyticsMetrics;
  byDirection: { LONG: TradeAnalyticsMetrics; SHORT: TradeAnalyticsMetrics };
  winnersLosers: WinnerLoserComparison;
  trades: NormalizedTrade[];
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

/** Builds a `?a=b&c=d` query string, omitting any empty/undefined filter values. */
function toQueryString<T extends object>(filters: T): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters as Record<string, string | undefined>)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getJournalEvents(filters: JournalEventFilters = {}): Promise<JournalEvent[]> {
  return apiFetch<JournalEvent[]>(`/journal/events${toQueryString(filters)}`);
}

export function getSetup(id: string): Promise<Setup> {
  return apiFetch<Setup>(`/setups/${id}`);
}

export function getSetupTimeline(id: string): Promise<JournalEvent[]> {
  return apiFetch<JournalEvent[]>(`/setups/${id}/timeline`);
}

export function getJournalTrades(filters: JournalTradeFilters = {}): Promise<JournalTrade[]> {
  return apiFetch<JournalTrade[]>(`/journal/trades${toQueryString(filters)}`);
}

export function getJournalTrade(id: string): Promise<JournalTrade> {
  return apiFetch<JournalTrade>(`/journal/trades/${id}`);
}

export function getAnalyticsStrategies(): Promise<StrategyGroupSummary[]> {
  return apiFetch<StrategyGroupSummary[]>("/analytics/strategies");
}

export function getAnalyticsStrategyVersionDetail(
  strategyId: string,
  versionId: string,
): Promise<StrategyVersionAnalyticsDetail> {
  return apiFetch<StrategyVersionAnalyticsDetail>(
    `/analytics/strategies/${strategyId}/versions/${versionId}`,
  );
}
