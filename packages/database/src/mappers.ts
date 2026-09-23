import { Decimal } from "decimal.js";
import type {
  Backtest,
  BacktestAssumptions,
  BacktestMetrics,
  BacktestTrade,
  Candle,
  InboundWebhookEvent,
  Instrument,
  JournalEvent,
  JournalTrade,
  MarketSnapshot,
  NotificationDelivery,
  PostTradeAnalysis,
  RiskCalculation,
  Setup,
  Strategy,
  StrategyVersion,
  TradeScreenshot,
  TradingViewInstrumentMapping,
} from "@trading-copilot/trading-domain";
import type {
  AssetClass,
  BacktestStatus,
  Direction,
  ExecutionMode,
  JournalEntityType,
  JournalEventType,
  JournalTradeStatus,
  LossCategory,
  NotificationDeliveryStatus,
  NotificationProviderType,
  NotificationType,
  PostTradeOutcome,
  ScreenshotStatus,
  ScreenshotType,
  SetupSource,
  SetupStatus,
  StrategyVersionStatus,
  Timeframe,
  TradeExitReason,
  TradeSource,
  WebhookProcessingStatus,
  WebhookProvider,
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

// ---------------------------------------------------------------------------
// Milestone 2 — MarketSnapshot / Setup / RiskCalculation / JournalTrade /
// JournalEvent / PostTradeAnalysis / TradeScreenshot
// ---------------------------------------------------------------------------

export interface PrismaMarketSnapshotRow {
  id: string;
  instrumentId: string;
  timestamp: Date;
  timeframe: string;
  windowCandleCount: number | null;
  windowStartTimestamp: Date | null;
  windowEndTimestamp: Date | null;
  trend1m: string | null;
  trend5m: string | null;
  trend15m: string | null;
  trend1h: string | null;
  trend4h: string | null;
  trend1d: string | null;
  atr: Decimalish | null;
  atrPercentile: Decimalish | null;
  volume: Decimalish | null;
  volumePercentile: Decimalish | null;
  vwap: Decimalish | null;
  vwapDistance: Decimalish | null;
  nearestSupport: Decimalish | null;
  distanceToSupport: Decimalish | null;
  nearestResistance: Decimalish | null;
  distanceToResistance: Decimalish | null;
  session: string | null;
  timeOfDay: string | null;
  dayOfWeek: string | null;
  marketRegime: string | null;
  metadata: unknown;
  createdAt: Date;
}

export function mapMarketSnapshot(row: PrismaMarketSnapshotRow): MarketSnapshot {
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    timestamp: row.timestamp,
    timeframe: row.timeframe as Timeframe,
    windowCandleCount: row.windowCandleCount,
    windowStartTimestamp: row.windowStartTimestamp,
    windowEndTimestamp: row.windowEndTimestamp,
    trend1m: row.trend1m,
    trend5m: row.trend5m,
    trend15m: row.trend15m,
    trend1h: row.trend1h,
    trend4h: row.trend4h,
    trend1d: row.trend1d,
    atr: toNullableDomainDecimal(row.atr),
    atrPercentile: toNullableDomainDecimal(row.atrPercentile),
    volume: toNullableDomainDecimal(row.volume),
    volumePercentile: toNullableDomainDecimal(row.volumePercentile),
    vwap: toNullableDomainDecimal(row.vwap),
    vwapDistance: toNullableDomainDecimal(row.vwapDistance),
    nearestSupport: toNullableDomainDecimal(row.nearestSupport),
    distanceToSupport: toNullableDomainDecimal(row.distanceToSupport),
    nearestResistance: toNullableDomainDecimal(row.nearestResistance),
    distanceToResistance: toNullableDomainDecimal(row.distanceToResistance),
    session: row.session,
    timeOfDay: row.timeOfDay,
    dayOfWeek: row.dayOfWeek,
    marketRegime: row.marketRegime,
    metadata: toRecord(row.metadata),
    createdAt: row.createdAt,
  };
}

export interface PrismaSetupRow {
  id: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  marketSnapshotId: string;
  direction: Direction;
  source: SetupSource;
  plannedEntry: Decimalish;
  plannedStop: Decimalish | null;
  plannedTarget1: Decimalish | null;
  plannedTarget2: Decimalish | null;
  status: SetupStatus;
  decisionSummary: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  sourceWebhookEventId: string | null;
}

export function mapSetup(row: PrismaSetupRow): Setup {
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    strategyId: row.strategyId,
    strategyVersionId: row.strategyVersionId,
    marketSnapshotId: row.marketSnapshotId,
    direction: row.direction,
    source: row.source,
    plannedEntry: toDomainDecimal(row.plannedEntry),
    plannedStop: toNullableDomainDecimal(row.plannedStop),
    plannedTarget1: toNullableDomainDecimal(row.plannedTarget1),
    plannedTarget2: toNullableDomainDecimal(row.plannedTarget2),
    status: row.status,
    decisionSummary: row.decisionSummary,
    metadata: toRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    sourceWebhookEventId: row.sourceWebhookEventId,
  };
}

export interface PrismaRiskCalculationRow {
  id: string;
  setupId: string;
  accountEquity: Decimalish;
  riskPercentage: Decimalish;
  riskBudget: Decimalish;
  entryPrice: Decimalish;
  stopPrice: Decimalish;
  stopDistancePoints: Decimalish;
  stopDistanceTicks: Decimalish;
  pointValue: Decimalish;
  tickValue: Decimalish;
  estimatedCommission: Decimalish;
  estimatedSlippage: Decimalish;
  riskPerUnit: Decimalish;
  calculatedQuantity: number;
  estimatedTotalRisk: Decimalish;
  riskReward: Decimalish;
  createdAt: Date;
}

export function mapRiskCalculation(row: PrismaRiskCalculationRow): RiskCalculation {
  return {
    id: row.id,
    setupId: row.setupId,
    accountEquity: toDomainDecimal(row.accountEquity),
    riskPercentage: toDomainDecimal(row.riskPercentage),
    riskBudget: toDomainDecimal(row.riskBudget),
    entryPrice: toDomainDecimal(row.entryPrice),
    stopPrice: toDomainDecimal(row.stopPrice),
    stopDistancePoints: toDomainDecimal(row.stopDistancePoints),
    stopDistanceTicks: toDomainDecimal(row.stopDistanceTicks),
    pointValue: toDomainDecimal(row.pointValue),
    tickValue: toDomainDecimal(row.tickValue),
    estimatedCommission: toDomainDecimal(row.estimatedCommission),
    estimatedSlippage: toDomainDecimal(row.estimatedSlippage),
    riskPerUnit: toDomainDecimal(row.riskPerUnit),
    calculatedQuantity: row.calculatedQuantity,
    estimatedTotalRisk: toDomainDecimal(row.estimatedTotalRisk),
    riskReward: toDomainDecimal(row.riskReward),
    createdAt: row.createdAt,
  };
}

export interface PrismaJournalTradeRow {
  id: string;
  setupId: string | null;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  plannedEntry: Decimalish;
  plannedStop: Decimalish;
  plannedTarget1: Decimalish | null;
  plannedTarget2: Decimalish | null;
  actualEntry: Decimalish | null;
  actualExit: Decimalish | null;
  entryTimestamp: Date | null;
  exitTimestamp: Date | null;
  quantity: number | null;
  plannedRisk: Decimalish | null;
  estimatedFees: Decimalish | null;
  actualFees: Decimalish | null;
  estimatedSlippage: Decimalish | null;
  actualSlippage: Decimalish | null;
  grossPnl: Decimalish | null;
  netPnl: Decimalish | null;
  rMultiple: Decimalish | null;
  mfe: Decimalish | null;
  mae: Decimalish | null;
  executionMode: ExecutionMode;
  status: JournalTradeStatus;
  entryNotes: string | null;
  exitNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapJournalTrade(row: PrismaJournalTradeRow): JournalTrade {
  return {
    id: row.id,
    setupId: row.setupId,
    instrumentId: row.instrumentId,
    strategyId: row.strategyId,
    strategyVersionId: row.strategyVersionId,
    direction: row.direction,
    plannedEntry: toDomainDecimal(row.plannedEntry),
    plannedStop: toDomainDecimal(row.plannedStop),
    plannedTarget1: toNullableDomainDecimal(row.plannedTarget1),
    plannedTarget2: toNullableDomainDecimal(row.plannedTarget2),
    actualEntry: toNullableDomainDecimal(row.actualEntry),
    actualExit: toNullableDomainDecimal(row.actualExit),
    entryTimestamp: row.entryTimestamp,
    exitTimestamp: row.exitTimestamp,
    quantity: row.quantity,
    plannedRisk: toNullableDomainDecimal(row.plannedRisk),
    estimatedFees: toNullableDomainDecimal(row.estimatedFees),
    actualFees: toNullableDomainDecimal(row.actualFees),
    estimatedSlippage: toNullableDomainDecimal(row.estimatedSlippage),
    actualSlippage: toNullableDomainDecimal(row.actualSlippage),
    grossPnl: toNullableDomainDecimal(row.grossPnl),
    netPnl: toNullableDomainDecimal(row.netPnl),
    rMultiple: toNullableDomainDecimal(row.rMultiple),
    mfe: toNullableDomainDecimal(row.mfe),
    mae: toNullableDomainDecimal(row.mae),
    executionMode: row.executionMode,
    status: row.status,
    entryNotes: row.entryNotes,
    exitNotes: row.exitNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface PrismaJournalEventRow {
  id: string;
  eventType: JournalEventType;
  timestamp: Date;
  // Monotonic insertion-order tiebreaker — see the model-level comment on
  // JournalEvent in prisma/schema.prisma. Used by mergeJournalEventRows to
  // break a timestamp tie; not exposed on the mapped JournalEvent domain
  // type.
  sequence: number;
  entityType: JournalEntityType;
  entityId: string;
  correlationId: string | null;
  instrumentId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  metadata: unknown;
}

export function mapJournalEvent(row: PrismaJournalEventRow): JournalEvent {
  return {
    id: row.id,
    eventType: row.eventType,
    timestamp: row.timestamp,
    entityType: row.entityType,
    entityId: row.entityId,
    correlationId: row.correlationId,
    instrumentId: row.instrumentId,
    strategyId: row.strategyId,
    strategyVersionId: row.strategyVersionId,
    metadata: toRecord(row.metadata),
  };
}

export interface PrismaPostTradeAnalysisRow {
  id: string;
  tradeId: string;
  tradeSource: TradeSource;
  outcome: PostTradeOutcome;
  primaryCause: LossCategory | null;
  contributingFactors: LossCategory[];
  confidence: Decimalish | null;
  evidence: unknown;
  researchHypotheses: string[];
  createdAt: Date;
}

export function mapPostTradeAnalysis(row: PrismaPostTradeAnalysisRow): PostTradeAnalysis {
  return {
    id: row.id,
    tradeId: row.tradeId,
    tradeSource: row.tradeSource,
    outcome: row.outcome,
    primaryCause: row.primaryCause,
    contributingFactors: row.contributingFactors,
    confidence: toNullableDomainDecimal(row.confidence),
    evidence: toRecord(row.evidence),
    researchHypotheses: row.researchHypotheses,
    createdAt: row.createdAt,
  };
}

export interface PrismaTradeScreenshotRow {
  id: string;
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  type: ScreenshotType;
  status: ScreenshotStatus;
  storageProvider: string;
  storageKey: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  marketSnapshotId: string | null;
  chartConfigVersion: string;
  renderedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapTradeScreenshot(row: PrismaTradeScreenshotRow): TradeScreenshot {
  return {
    id: row.id,
    setupId: row.setupId,
    tradeId: row.tradeId,
    tradeSource: row.tradeSource,
    type: row.type,
    status: row.status,
    storageProvider: row.storageProvider,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    marketSnapshotId: row.marketSnapshotId,
    chartConfigVersion: row.chartConfigVersion,
    renderedAt: row.renderedAt,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Milestone 6: NotificationDelivery
// ---------------------------------------------------------------------------

export interface PrismaNotificationDeliveryRow {
  id: string;
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  provider: NotificationProviderType;
  notificationType: NotificationType;
  templateVersion: string;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  queuedAt: Date;
  sendingAt: Date | null;
  sentAt: Date | null;
  externalMessageId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapNotificationDelivery(row: PrismaNotificationDeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    setupId: row.setupId,
    tradeId: row.tradeId,
    tradeSource: row.tradeSource,
    provider: row.provider,
    notificationType: row.notificationType,
    templateVersion: row.templateVersion,
    status: row.status,
    attemptCount: row.attemptCount,
    queuedAt: row.queuedAt,
    sendingAt: row.sendingAt,
    sentAt: row.sentAt,
    externalMessageId: row.externalMessageId,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Milestone 3: InboundWebhookEvent / TradingViewInstrumentMapping
// ---------------------------------------------------------------------------

export interface PrismaInboundWebhookEventRow {
  id: string;
  provider: WebhookProvider;
  receivedAt: Date;
  schemaVersion: number;
  rawPayload: unknown;
  normalizedPayload: unknown;
  fingerprint: string;
  processingStatus: WebhookProcessingStatus;
  processingStartedAt: Date | null;
  processingCompletedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  setupId: string | null;
  createdAt: Date;
}

export function mapInboundWebhookEvent(row: PrismaInboundWebhookEventRow): InboundWebhookEvent {
  return {
    id: row.id,
    provider: row.provider,
    receivedAt: row.receivedAt,
    schemaVersion: row.schemaVersion,
    rawPayload: toRecord(row.rawPayload),
    normalizedPayload: row.normalizedPayload === null ? null : toRecord(row.normalizedPayload),
    fingerprint: row.fingerprint,
    processingStatus: row.processingStatus,
    processingStartedAt: row.processingStartedAt,
    processingCompletedAt: row.processingCompletedAt,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    setupId: row.setupId,
    createdAt: row.createdAt,
  };
}

export interface PrismaTradingViewInstrumentMappingRow {
  id: string;
  exchange: string;
  symbol: string;
  instrumentId: string;
  createdAt: Date;
}

export function mapTradingViewInstrumentMapping(
  row: PrismaTradingViewInstrumentMappingRow,
): TradingViewInstrumentMapping {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    instrumentId: row.instrumentId,
    createdAt: row.createdAt,
  };
}
