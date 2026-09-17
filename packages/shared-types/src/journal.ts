import { z } from "zod";
import {
  DIRECTIONS,
  EXECUTION_MODES,
  SETUP_SOURCES,
  SETUP_STATUSES,
  TIMEFRAMES,
} from "./enums";

/**
 * Milestone 2 journal/analytics request schemas.
 *
 * Deliberately excluded from every schema below: any field the server must
 * compute deterministically (risk numbers, P&L, R multiple). Those are never
 * accepted as client input — see packages/risk-engine and the closing
 * comment on closeJournalTradeSchema.
 */

const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, `${label} must be a plain decimal number string`);

const positiveDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^(?!0(?:\.0+)?$)\d+(\.\d+)?$/, `${label} must be a positive decimal string (not zero)`);

const nonNegativeDecimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a non-negative decimal string`);

// --- MarketSnapshot -------------------------------------------------------

export const createMarketSnapshotSchema = z.object({
  instrumentId: z.string().uuid(),
  timestamp: z.string().datetime({ message: "timestamp must be ISO-8601 UTC" }),
  timeframe: z.enum(TIMEFRAMES),
  windowCandleCount: z.number().int().positive().optional(),
  windowStartTimestamp: z.string().datetime().optional(),
  windowEndTimestamp: z.string().datetime().optional(),
  trend1m: z.string().trim().min(1).optional(),
  trend5m: z.string().trim().min(1).optional(),
  trend15m: z.string().trim().min(1).optional(),
  trend1h: z.string().trim().min(1).optional(),
  trend4h: z.string().trim().min(1).optional(),
  trend1d: z.string().trim().min(1).optional(),
  atr: nonNegativeDecimalString("atr").optional(),
  atrPercentile: nonNegativeDecimalString("atrPercentile").optional(),
  volume: nonNegativeDecimalString("volume").optional(),
  volumePercentile: nonNegativeDecimalString("volumePercentile").optional(),
  vwap: nonNegativeDecimalString("vwap").optional(),
  vwapDistance: decimalString("vwapDistance").optional(),
  nearestSupport: nonNegativeDecimalString("nearestSupport").optional(),
  distanceToSupport: decimalString("distanceToSupport").optional(),
  nearestResistance: nonNegativeDecimalString("nearestResistance").optional(),
  distanceToResistance: decimalString("distanceToResistance").optional(),
  session: z.string().trim().min(1).optional(),
  timeOfDay: z.string().trim().min(1).optional(),
  dayOfWeek: z.string().trim().min(1).optional(),
  marketRegime: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateMarketSnapshotInput = z.infer<typeof createMarketSnapshotSchema>;

// --- Setup ------------------------------------------------------------

export const createSetupSchema = z.object({
  instrumentId: z.string().uuid(),
  strategyId: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  marketSnapshotId: z.string().uuid(),
  direction: z.enum(DIRECTIONS),
  source: z.enum(SETUP_SOURCES),
  plannedEntry: positiveDecimalString("plannedEntry"),
  plannedStop: positiveDecimalString("plannedStop"),
  plannedTarget1: positiveDecimalString("plannedTarget1"),
  plannedTarget2: positiveDecimalString("plannedTarget2").optional(),
  decisionSummary: z.string().trim().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.string().datetime().optional(),
});
export type CreateSetupInput = z.infer<typeof createSetupSchema>;

export const updateSetupStatusSchema = z.object({
  status: z.enum(SETUP_STATUSES),
  decisionSummary: z.string().trim().max(2000).optional(),
});
export type UpdateSetupStatusInput = z.infer<typeof updateSetupStatusSchema>;

export const setupListQuerySchema = z.object({
  instrumentId: z.string().uuid().optional(),
  strategyId: z.string().uuid().optional(),
  strategyVersionId: z.string().uuid().optional(),
  status: z.enum(SETUP_STATUSES).optional(),
  source: z.enum(SETUP_SOURCES).optional(),
  direction: z.enum(DIRECTIONS).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type SetupListQuery = z.infer<typeof setupListQuerySchema>;

// --- RiskCalculation --------------------------------------------------

/**
 * Only the inputs a human/service actually chooses are accepted here.
 * entryPrice/stopPrice are read from the linked Setup (not re-supplied by
 * the caller) and tick/point/commission values from the linked Instrument —
 * every other RiskCalculation field is computed by apps/api's risk service
 * calling straight into packages/risk-engine. See CLAUDE.md: financial
 * calculations are never independently produced in a controller.
 */
export const createRiskCalculationSchema = z.object({
  accountEquity: positiveDecimalString("accountEquity"),
  riskPercentage: nonNegativeDecimalString("riskPercentage"),
  slippageTicks: z.number().int().min(0).default(0),
});
export type CreateRiskCalculationInput = z.infer<typeof createRiskCalculationSchema>;

// --- JournalTrade -------------------------------------------------------

/**
 * A JournalTrade is created for a real (paper or manual-live) trade, or to
 * record that a READY setup was deliberately skipped. It is never created
 * with executionMode "BACKTEST" through this endpoint — that value exists
 * only in the normalized analytics view over BacktestTrade rows (see
 * packages/analytics); creating a literal JournalTrade row that claims to be
 * a backtest would duplicate data that packages/database's BacktestTrade
 * table already owns.
 */
export const createJournalTradeSchema = z.object({
  setupId: z.string().uuid().optional(),
  instrumentId: z.string().uuid(),
  strategyId: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  direction: z.enum(DIRECTIONS),
  plannedEntry: positiveDecimalString("plannedEntry"),
  plannedStop: positiveDecimalString("plannedStop"),
  plannedTarget1: positiveDecimalString("plannedTarget1").optional(),
  plannedTarget2: positiveDecimalString("plannedTarget2").optional(),
  plannedRisk: nonNegativeDecimalString("plannedRisk").optional(),
  executionMode: z.enum(["PAPER", "MANUAL_LIVE", "SKIPPED"]),
  entryNotes: z.string().trim().max(2000).optional(),
});
export type CreateJournalTradeInput = z.infer<typeof createJournalTradeSchema>;

export const recordJournalTradeEntrySchema = z.object({
  actualEntry: positiveDecimalString("actualEntry"),
  entryTimestamp: z.string().datetime(),
  quantity: z.number().int().positive(),
  estimatedFees: nonNegativeDecimalString("estimatedFees").optional(),
  estimatedSlippage: nonNegativeDecimalString("estimatedSlippage").optional(),
});
export type RecordJournalTradeEntryInput = z.infer<typeof recordJournalTradeEntrySchema>;

export const closeJournalTradeSchema = z.object({
  actualExit: positiveDecimalString("actualExit"),
  exitTimestamp: z.string().datetime(),
  actualFees: nonNegativeDecimalString("actualFees").optional(),
  actualSlippage: nonNegativeDecimalString("actualSlippage").optional(),
  mfe: nonNegativeDecimalString("mfe").optional(),
  mae: nonNegativeDecimalString("mae").optional(),
  exitNotes: z.string().trim().max(2000).optional(),
});
export type CloseJournalTradeInput = z.infer<typeof closeJournalTradeSchema>;

export const journalTradeListQuerySchema = z.object({
  instrumentId: z.string().uuid().optional(),
  strategyId: z.string().uuid().optional(),
  strategyVersionId: z.string().uuid().optional(),
  direction: z.enum(DIRECTIONS).optional(),
  executionMode: z.enum(EXECUTION_MODES).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type JournalTradeListQuery = z.infer<typeof journalTradeListQuerySchema>;

// --- Analytics ------------------------------------------------------------

export const analyticsQuerySchema = z.object({
  strategyId: z.string().uuid().optional(),
  strategyVersionId: z.string().uuid().optional(),
  instrumentId: z.string().uuid().optional(),
  direction: z.enum(DIRECTIONS).optional(),
  executionMode: z.enum(EXECUTION_MODES).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
