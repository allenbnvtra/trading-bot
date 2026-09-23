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

export interface TradingViewIngestionHealth {
  status: "ONLINE" | "DEGRADED" | "UNKNOWN";
  lastEventAt: string | null;
  lastSuccessfulProcessingAt: string | null;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  postgres: "up" | "down";
  redis: "up" | "down";
  tradingViewIngestion: TradingViewIngestionHealth;
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
  | "STRATEGY_VERSION_PROPOSED"
  | "WEBHOOK_RECEIVED"
  | "WEBHOOK_NORMALIZED"
  | "SIGNAL_ACCEPTED"
  | "WEBHOOK_DUPLICATE_DETECTED"
  | "WEBHOOK_REJECTED"
  | "WEBHOOK_PROCESSING_FAILED";

export type JournalEntityType =
  | "SETUP"
  | "JOURNAL_TRADE"
  | "RISK_CALCULATION"
  | "MARKET_SNAPSHOT"
  | "BACKTEST"
  | "BACKTEST_TRADE"
  | "STRATEGY_VERSION"
  | "POST_TRADE_ANALYSIS"
  | "INBOUND_WEBHOOK_EVENT";

export type SetupStatus = "WATCH" | "PREPARE" | "READY" | "REJECTED" | "INVALIDATED" | "EXPIRED";
export type SetupSource = "BACKTEST" | "MANUAL_TEST" | "SYSTEM" | "TRADINGVIEW";
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
  /** Null for a TradingView-sourced Setup until a RiskCalculation supplies one. Never fabricate a value here - render "not set". */
  plannedStop: string | null;
  /** Same nullability note as plannedStop. */
  plannedTarget1: string | null;
  plannedTarget2: string | null;
  status: SetupStatus;
  decisionSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface SetupListFilters {
  instrumentId?: string;
  strategyId?: string;
  strategyVersionId?: string;
  status?: SetupStatus;
  source?: SetupSource;
  direction?: Direction;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Immutable "what the market looked like" context a Setup points at. A
 * TradingView-sourced Setup's timeframe/bar time live here, not on the
 * Setup itself - see packages/trading-domain's MarketSnapshot.
 *
 * This is a deliberately partial mirror of the domain type (matches this
 * file's existing convention of hand-mirroring only the fields a dashboard
 * route actually consumes, not every column) - `nearestSupport`/
 * `nearestResistance` were added here because the PRE_TRADE chart render
 * route (`app/internal/render/setup/[setupId]/page.tsx`) reads them for the
 * chart's support/resistance annotation lines.
 */
export interface MarketSnapshot {
  id: string;
  instrumentId: string;
  /** The market bar this snapshot is about (e.g. the alert's OHLCV bar close time) - distinct from when our system received/created anything. */
  timestamp: string;
  timeframe: string;
  atr: string | null;
  volume: string | null;
  vwap: string | null;
  nearestSupport: string | null;
  nearestResistance: string | null;
  session: string | null;
  marketRegime: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * A deterministic risk calculation, always produced by
 * packages/risk-engine and never independently computed here - see
 * packages/trading-domain's RiskCalculation. Immutable once created: a
 * Setup that needs a fresh calculation gets a new row, not an update to an
 * old one.
 */
export interface RiskCalculation {
  id: string;
  setupId: string;
  accountEquity: string;
  riskPercentage: string;
  riskBudget: string;
  entryPrice: string;
  stopPrice: string;
  stopDistancePoints: string;
  stopDistanceTicks: string;
  pointValue: string;
  tickValue: string;
  estimatedCommission: string;
  estimatedSlippage: string;
  riskPerUnit: string;
  calculatedQuantity: number;
  estimatedTotalRisk: string;
  riskReward: string;
  createdAt: string;
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

export function getInstrument(id: string): Promise<Instrument> {
  return apiFetch<Instrument>(`/instruments/${id}`);
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

export function getSetups(filters: SetupListFilters = {}): Promise<Setup[]> {
  return apiFetch<Setup[]>(`/setups${toQueryString(filters)}`);
}

export function getSetup(id: string): Promise<Setup> {
  return apiFetch<Setup>(`/setups/${id}`);
}

export function getSetupTimeline(id: string): Promise<JournalEvent[]> {
  return apiFetch<JournalEvent[]>(`/setups/${id}/timeline`);
}

export function getMarketSnapshot(id: string): Promise<MarketSnapshot> {
  return apiFetch<MarketSnapshot>(`/market-snapshots/${id}`);
}

export function getLatestRiskCalculation(setupId: string): Promise<RiskCalculation> {
  return apiFetch<RiskCalculation>(`/setups/${setupId}/risk-calculations/latest`);
}

/**
 * The anti-look-ahead-safe candle query (docs/screenshot-design.md). Every
 * caller of this function must pass an authoritative decision-time
 * timestamp as `cutoffTimestamp` (e.g. `MarketSnapshot.timestamp` for a
 * PRE_TRADE render, `JournalTrade.exitTimestamp` for POST_TRADE) - never
 * `new Date()` or anything client/URL-controlled. This function itself has
 * no way to enforce that; it's a call-site responsibility - see
 * `app/internal/render/setup/[setupId]/page.tsx`.
 */
export function getCandlesUpToTimestamp(
  instrumentId: string,
  timeframe: string,
  cutoffTimestamp: string,
  count: number,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    instrumentId,
    timeframe,
    cutoffTimestamp,
    count: String(count),
  });
  return apiFetch<Candle[]>(`/market-data/candles?${params.toString()}`);
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

// --- Milestone 3: TradingView webhook ingestion admin/inspection --------

export type WebhookProvider = "TRADINGVIEW";

export type WebhookProcessingStatus =
  | "RECEIVED"
  | "QUEUED"
  | "PROCESSING"
  | "PROCESSED"
  | "DUPLICATE"
  | "REJECTED"
  | "FAILED"
  | "UNSUPPORTED";

/**
 * Known failure codes the ingestion pipeline itself produces. Stored as a
 * plain string on the API side (not a DB enum), so an unanticipated value
 * is rendered as-is rather than dropped - see failureCode's type below.
 */
export type WebhookFailureCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "MALFORMED_PAYLOAD"
  | "UNSUPPORTED_SIGNAL_TYPE"
  | "UNSUPPORTED_TIMEFRAME"
  | "UNKNOWN_INSTRUMENT"
  | "UNKNOWN_STRATEGY_VERSION"
  | "INTERNAL_ERROR";

/**
 * The durable record of one physical webhook delivery. rawPayload/
 * normalizedPayload are already sanitized of secrets at the source (see
 * docs/tradingview-security.md) - nothing further needs to be redacted
 * here, only rendered readably.
 */
export interface InboundWebhookEvent {
  id: string;
  provider: WebhookProvider;
  receivedAt: string;
  schemaVersion: number;
  rawPayload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown> | null;
  fingerprint: string;
  processingStatus: WebhookProcessingStatus;
  processingStartedAt: string | null;
  processingCompletedAt: string | null;
  failureCode: WebhookFailureCode | string | null;
  failureMessage: string | null;
  setupId: string | null;
  createdAt: string;
}

export interface WebhookEventListFilters {
  provider?: WebhookProvider;
  processingStatus?: WebhookProcessingStatus;
  setupId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function getWebhookEvents(
  filters: WebhookEventListFilters = {},
): Promise<InboundWebhookEvent[]> {
  return apiFetch<InboundWebhookEvent[]>(`/webhooks/tradingview/events${toQueryString(filters)}`);
}

export function getWebhookEvent(id: string): Promise<InboundWebhookEvent> {
  return apiFetch<InboundWebhookEvent>(`/webhooks/tradingview/events/${id}`);
}

export function getWebhookEventTimeline(id: string): Promise<JournalEvent[]> {
  return apiFetch<JournalEvent[]>(`/webhooks/tradingview/events/${id}/timeline`);
}

// --- Milestone 3: realtime notifications ---------------------------------
//
// Mirrors packages/shared-types/src/realtime.ts's RealtimeEvent shape by
// hand, same as every other type in this file - the dashboard never adds a
// workspace dependency on @trading-copilot/shared-types, it stays decoupled
// and mirrors whatever shape the API/WebSocket actually sends.

// --- Milestone 5: chart screenshot generation ----------------------------
//
// Mirrors packages/shared-types/src/screenshot.ts's TradeScreenshot-adjacent
// shapes by hand, same as every other type in this file - this module never
// takes a workspace dependency on @trading-copilot/shared-types (its CJS
// barrel transitively pulls in node:crypto via tradingview.ts, which breaks
// a browser bundle; see ChartRenderer.tsx for the same note).

export type ScreenshotType = "PRE_TRADE" | "POST_TRADE";
export type ScreenshotStatus = "REQUESTED" | "GENERATING" | "READY" | "FAILED";
export type TradeScreenshotSource = "BACKTEST_TRADE" | "JOURNAL_TRADE";

/**
 * A chart-render job's durable record (packages/trading-domain's
 * TradeScreenshot). A READY row's pixels are fetched separately via
 * `GET /screenshots/:id/image` - this object never carries the image bytes
 * itself, only status/metadata.
 */
export interface TradeScreenshot {
  id: string;
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeScreenshotSource | null;
  type: ScreenshotType;
  status: ScreenshotStatus;
  storageProvider: string;
  storageKey: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  marketSnapshotId: string | null;
  chartConfigVersion: string;
  renderedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getSetupScreenshots(setupId: string): Promise<TradeScreenshot[]> {
  return apiFetch<TradeScreenshot[]>(`/setups/${setupId}/screenshots`);
}

// --- Milestone 6: notifications + manual trade workflow ------------------
//
// Mirrors packages/shared-types/src/notifications.ts's NOTIFICATION_TYPES /
// SKIP_REASONS enums and executeSetupSchema/skipSetupSchema by hand, same
// as every other type in this file - this module never takes a workspace
// dependency on @trading-copilot/shared-types (see ScreenshotType's note
// above for why).

export type NotificationType =
  | "SETUP_PREPARE"
  | "SETUP_READY"
  | "SETUP_INVALIDATED"
  | "SETUP_EXPIRED"
  | "SETUP_REJECTED";

export type NotificationProviderType = "TELEGRAM" | "CONSOLE";

export type NotificationDeliveryStatus = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "RETRYING";

/**
 * A dashboard-relevant subset of packages/trading-domain's
 * NotificationDelivery - only the fields the Setup detail page's
 * "Notifications" status block actually renders, same convention as
 * MarketSnapshot above.
 */
export interface NotificationDelivery {
  id: string;
  notificationType: NotificationType;
  provider: NotificationProviderType;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  sentAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export function getSetupNotifications(setupId: string): Promise<NotificationDelivery[]> {
  return apiFetch<NotificationDelivery[]>(`/setups/${setupId}/notifications`);
}

/** Mirrors SKIP_REASONS in packages/shared-types/src/enums.ts exactly. */
export const SKIP_REASONS = [
  "MISSED_ALERT",
  "PRICE_MOVED",
  "MANUAL_DISAGREEMENT",
  "RISK_TOO_HIGH",
  "BUSY",
  "SETUP_NO_LONGER_VALID",
  "OTHER",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * The dashboard's single-action "record what I actually did" call, backing
 * the PAPER TRADE / I ENTERED THIS TRADE buttons on the Setup detail page.
 * Mirrors executeSetupSchema in packages/shared-types/src/notifications.ts -
 * executionMode is deliberately restricted to PAPER|MANUAL_LIVE, never the
 * full ExecutionMode union (BACKTEST/SKIPPED go through other paths).
 */
export interface ExecuteSetupInput {
  executionMode: "PAPER" | "MANUAL_LIVE";
  actualEntry: string;
  quantity: number;
  entryTimestamp: string;
  actualFees?: string;
  actualSlippage?: string;
  notes?: string;
}

export function executeSetup(setupId: string, input: ExecuteSetupInput): Promise<JournalTrade> {
  return apiFetch<JournalTrade>(`/setups/${setupId}/execute`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Backs the SKIP TRADE button. Mirrors skipSetupSchema - reason is optional. */
export function skipSetup(setupId: string, reason?: SkipReason): Promise<JournalTrade> {
  return apiFetch<JournalTrade>(`/setups/${setupId}/skip`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/**
 * Idempotent-safe manual/admin trigger (docs/screenshot-design.md): a FAILED
 * row is reset to REQUESTED and re-enqueued, a READY row is returned
 * unchanged. Safe to call again as a "Retry" action - never a different
 * endpoint from the one automatically triggered server-side.
 */
export function requestPreTradeScreenshot(setupId: string): Promise<TradeScreenshot> {
  return apiFetch<TradeScreenshot>(`/setups/${setupId}/screenshots/pre-trade`, {
    method: "POST",
  });
}

export function getTradeScreenshots(tradeId: string): Promise<TradeScreenshot[]> {
  return apiFetch<TradeScreenshot[]>(`/journal/trades/${tradeId}/screenshots`);
}

/** Same idempotent-safe contract as requestPreTradeScreenshot, for POST_TRADE. */
export function requestPostTradeScreenshot(tradeId: string): Promise<TradeScreenshot> {
  return apiFetch<TradeScreenshot>(`/journal/trades/${tradeId}/screenshots/post-trade`, {
    method: "POST",
  });
}

export interface WebhookReceivedRealtimeEvent {
  type: "webhook.received";
  timestamp: string;
  webhookEventId: string;
  provider: string;
}

export interface SetupRealtimeEvent {
  type: "setup.created" | "setup.updated" | "setup.expired" | "setup.invalidated" | "setup.rejected";
  timestamp: string;
  setupId: string;
  instrumentId: string;
  status: SetupStatus;
  direction: Direction;
}

export type RealtimeEvent = WebhookReceivedRealtimeEvent | SetupRealtimeEvent;
