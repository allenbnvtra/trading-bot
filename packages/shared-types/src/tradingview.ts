import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DIRECTIONS,
  TIMEFRAMES,
  TRADINGVIEW_SIGNAL_TYPES,
  WEBHOOK_PROCESSING_STATUSES,
  WEBHOOK_PROVIDERS,
  type Timeframe,
} from "./enums";

/**
 * TradingView webhook payload handling (Milestone 3 — see
 * docs/tradingview-setup.md). Everything in this file is pure (no I/O): the
 * Zod schemas, the fingerprint function, and the payload -> normalized-shape
 * transform. apps/api uses the envelope/v1 schemas + fingerprint at ingestion
 * time (fast, synchronous); apps/worker uses `normalizeTradingViewPayload`
 * when it actually processes the queued event. This split mirrors
 * docs/trade-journal-design.md's "raw vs normalized" distinction.
 */

const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, `${label} must be a non-negative plain decimal number string`);

/**
 * The only two fields validated before we even know whether we understand
 * this payload's shape. `.passthrough()` deliberately keeps every other
 * field around unparsed — an unsupported schemaVersion must never crash the
 * request; it gets stored as-is and marked UNSUPPORTED downstream.
 */
export const tradingViewWebhookEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int(),
    source: z.literal("TRADINGVIEW"),
  })
  .passthrough();
export type TradingViewWebhookEnvelope = z.infer<typeof tradingViewWebhookEnvelopeSchema>;

/** Currently the only schemaVersion this codebase understands how to process. */
export const SUPPORTED_TRADINGVIEW_SCHEMA_VERSION = 1;

/**
 * Strict shape for schemaVersion 1. Every numeric/price field is a decimal
 * string at the transport boundary (never trust a wire-format float) and is
 * parsed into Decimal only once resolved into a NormalizedTradingViewSignal
 * below — see CLAUDE.md "financial calculations ... Decimal ... never
 * careless floating point".
 */
export const tradingViewWebhookV1Schema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("TRADINGVIEW"),
  strategyKey: z.string().trim().min(1),
  strategyVersion: z.string().trim().min(1),
  exchange: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  timeframe: z.string().trim().min(1),
  signal: z.string().trim().min(1),
  direction: z.enum(DIRECTIONS),
  barTime: z.string().datetime({ message: "barTime must be ISO-8601 UTC" }),
  firedAt: z.string().datetime({ message: "firedAt must be ISO-8601 UTC" }),
  open: decimalString("open"),
  high: decimalString("high"),
  low: decimalString("low"),
  close: decimalString("close"),
  volume: decimalString("volume"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type TradingViewWebhookV1Payload = z.infer<typeof tradingViewWebhookV1Schema>;

/**
 * Deterministic identity of "the same logical TradingView trigger" — see
 * docs/tradingview-setup.md "Idempotency". Deliberately excludes `firedAt`
 * (wall-clock delivery time, which legitimately differs between a genuine
 * retry and a fresh duplicate) and the OHLCV fields (redundant for a true
 * duplicate — the same bar has the same prices — and including them would
 * make the fingerprint fragile to harmless formatting differences, e.g.
 * trailing-zero variance, between deliveries). `barTime` (the market bar
 * this signal is *about*) is what actually identifies which trigger this is.
 * Every field is lowercased/trimmed first so case or incidental whitespace
 * differences between deliveries of the same alert never produce a
 * different fingerprint.
 */
export function computeTradingViewFingerprint(
  payload: Pick<
    TradingViewWebhookV1Payload,
    "strategyKey" | "strategyVersion" | "exchange" | "symbol" | "timeframe" | "signal" | "direction" | "barTime"
  >,
): string {
  const canonical = [
    "TRADINGVIEW",
    payload.strategyKey,
    payload.strategyVersion,
    payload.exchange,
    payload.symbol,
    payload.timeframe,
    payload.signal,
    payload.direction,
    payload.barTime,
  ]
    .map((field) => field.trim().toLowerCase())
    .join("|");

  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * TradingView's `{{interval}}` placeholder emits its own compact codes
 * ("1", "5", "15", "60", "240", "D", ...), not this project's internal
 * Timeframe strings. An interval this codebase doesn't have a mapping for
 * is a normalization failure (UNSUPPORTED_TIMEFRAME), never a guess.
 */
export const TRADINGVIEW_TIMEFRAME_MAP: Readonly<Record<string, Timeframe>> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "60": "1h",
  "240": "4h",
  D: "1d",
  "1D": "1d",
};

export function mapTradingViewTimeframe(rawInterval: string): Timeframe | null {
  const mapped = TRADINGVIEW_TIMEFRAME_MAP[rawInterval.trim()];
  return mapped && (TIMEFRAMES as readonly string[]).includes(mapped) ? mapped : null;
}

/**
 * The cleaned, provider-shaped-but-not-yet-DB-resolved intermediate. Still
 * carries `exchange`/`symbol`/`strategyKey`/`strategyVersion` as strings —
 * resolving those into real instrumentId/strategyId/strategyVersionId
 * happens in a later step (apps/worker, which has database access), never
 * in this pure module. See packages/trading-domain's `NormalizedSignal` for
 * the fully-resolved shape this feeds into.
 */
export interface NormalizedTradingViewPayload {
  source: "TRADINGVIEW";
  externalEventFingerprint: string;
  strategyKey: string;
  strategyVersion: string;
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  signalType: (typeof TRADINGVIEW_SIGNAL_TYPES)[number];
  direction: "LONG" | "SHORT";
  barTimestamp: string;
  receivedTimestamp: string;
  priceContext: {
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  };
  metadata: Record<string, unknown>;
}

export type NormalizeTradingViewPayloadResult =
  | { ok: true; signal: NormalizedTradingViewPayload }
  | { ok: false; failureCode: "UNSUPPORTED_SIGNAL_TYPE" | "UNSUPPORTED_TIMEFRAME" | "MALFORMED_PAYLOAD"; message: string };

/**
 * Pure transform: validated v1 payload -> NormalizedTradingViewPayload.
 * Never throws — every failure mode is a typed result the caller (the
 * worker) uses to mark the InboundWebhookEvent REJECTED/UNSUPPORTED with a
 * useful reason, per docs/tradingview-setup.md.
 */
export function normalizeTradingViewPayload(
  payload: TradingViewWebhookV1Payload,
  receivedTimestamp: Date,
): NormalizeTradingViewPayloadResult {
  if (!(TRADINGVIEW_SIGNAL_TYPES as readonly string[]).includes(payload.signal)) {
    return {
      ok: false,
      failureCode: "UNSUPPORTED_SIGNAL_TYPE",
      message: `Unsupported signal type "${payload.signal}". Supported: ${TRADINGVIEW_SIGNAL_TYPES.join(", ")}`,
    };
  }

  const timeframe = mapTradingViewTimeframe(payload.timeframe);
  if (!timeframe) {
    return {
      ok: false,
      failureCode: "UNSUPPORTED_TIMEFRAME",
      message: `Unsupported TradingView timeframe "${payload.timeframe}" — no internal Timeframe mapping exists for it.`,
    };
  }

  // Candle invariants (same discipline as packages/database's CSV importer,
  // see packages/shared-types/src/csv-candle.ts) — reject, never clamp/fix.
  const open = Number(payload.open);
  const high = Number(payload.high);
  const low = Number(payload.low);
  const close = Number(payload.close);
  const volume = Number(payload.volume);
  const invariantErrors: string[] = [];
  if (high < open) invariantErrors.push("high must be >= open");
  if (high < close) invariantErrors.push("high must be >= close");
  if (high < low) invariantErrors.push("high must be >= low");
  if (low > open) invariantErrors.push("low must be <= open");
  if (low > close) invariantErrors.push("low must be <= close");
  if (volume < 0) invariantErrors.push("volume must be >= 0");
  if (invariantErrors.length > 0) {
    return { ok: false, failureCode: "MALFORMED_PAYLOAD", message: invariantErrors.join("; ") };
  }

  return {
    ok: true,
    signal: {
      source: "TRADINGVIEW",
      externalEventFingerprint: computeTradingViewFingerprint(payload),
      strategyKey: payload.strategyKey,
      strategyVersion: payload.strategyVersion,
      exchange: payload.exchange,
      symbol: payload.symbol,
      timeframe,
      signalType: payload.signal as (typeof TRADINGVIEW_SIGNAL_TYPES)[number],
      direction: payload.direction,
      barTimestamp: payload.barTime,
      receivedTimestamp: receivedTimestamp.toISOString(),
      priceContext: {
        open: payload.open,
        high: payload.high,
        low: payload.low,
        close: payload.close,
        volume: payload.volume,
      },
      metadata: payload.metadata,
    },
  };
}

// --- BullMQ job contract ---------------------------------------------------

/**
 * Shared by apps/api (producer) and apps/worker (consumer) — unlike
 * Milestone 1's BACKTEST_RUN_QUEUE constants (duplicated by file in each
 * app "by convention"), this one is a real shared import: both apps already
 * depend on @trading-copilot/shared-types, so there's no reason to risk the
 * two copies drifting. The payload is intentionally minimal — the worker
 * re-fetches everything else from Postgres via the id, so Postgres stays
 * the single source of truth and the job payload can never go stale.
 */
export const TRADINGVIEW_WEBHOOK_QUEUE = "tradingview-webhook-event";
export const TRADINGVIEW_WEBHOOK_JOB = "process";

export interface TradingViewWebhookJobPayload {
  inboundWebhookEventId: string;
}

// --- Admin/inspection query schema ---------------------------------------

/** GET /webhooks/tradingview/events query filters — the admin/inspection surface (section 22). */
export const inboundWebhookEventListQuerySchema = z.object({
  provider: z.enum(WEBHOOK_PROVIDERS).optional(),
  processingStatus: z.enum(WEBHOOK_PROCESSING_STATUSES).optional(),
  setupId: z.string().uuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
export type InboundWebhookEventListQuery = z.infer<typeof inboundWebhookEventListQuerySchema>;
