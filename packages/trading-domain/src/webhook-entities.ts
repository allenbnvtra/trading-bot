import type Decimal from "decimal.js";
import type {
  Direction,
  JournalEventType,
  Timeframe,
  TradingViewSignalType,
  WebhookFailureCode,
  WebhookProcessingStatus,
  WebhookProvider,
} from "@trading-copilot/shared-types";

/**
 * Milestone 3 — TradingView webhook ingestion entities. Real, persisted
 * tables (see packages/database/prisma/schema.prisma), same conventions as
 * packages/trading-domain/src/journal-entities.ts: Decimal for money/price
 * fields, decoupled from Prisma's generated types.
 */

/**
 * The durable record of one physical webhook delivery. Immutable except for
 * its processing-lifecycle fields (processingStatus, processingStartedAt,
 * processingCompletedAt, failureCode, failureMessage, setupId,
 * normalizedPayload) — rawPayload/fingerprint/schemaVersion/provider/
 * receivedAt are set once at creation and never changed. `fingerprint` has
 * a database unique constraint: this is the actual idempotency guarantee
 * (a duplicate delivery cannot even be inserted, let alone processed
 * twice) — see docs/tradingview-setup.md "Idempotency".
 */
export interface InboundWebhookEvent {
  id: string;
  provider: WebhookProvider;
  receivedAt: Date;
  schemaVersion: number;
  /** The exact body received, as parsed JSON. Never put credentials in an alert message — see docs/tradingview-security.md. */
  rawPayload: Record<string, unknown>;
  /** Populated once normalization succeeds; null before that or if normalization never succeeded (REJECTED/UNSUPPORTED). */
  normalizedPayload: Record<string, unknown> | null;
  fingerprint: string;
  processingStatus: WebhookProcessingStatus;
  processingStartedAt: Date | null;
  processingCompletedAt: Date | null;
  failureCode: WebhookFailureCode | string | null;
  failureMessage: string | null;
  setupId: string | null;
  createdAt: Date;
}

/**
 * Explicit exchange+symbol -> Instrument mapping (Milestone 3). A webhook
 * naming an unmapped symbol is rejected (UNKNOWN_INSTRUMENT) — this
 * codebase never auto-creates an Instrument from webhook data, and never
 * guesses a mapping by fuzzy-matching a symbol string.
 */
export interface TradingViewInstrumentMapping {
  id: string;
  exchange: string;
  symbol: string;
  instrumentId: string;
  createdAt: Date;
}

/**
 * The fully-resolved, provider-agnostic signal a worker builds after
 * normalizing a raw payload (packages/shared-types'
 * NormalizedTradingViewPayload) AND resolving its identifiers against the
 * database (Instrument, Strategy, StrategyVersion). This is the shape
 * that's actually turned into a Setup — see docs/tradingview-setup.md
 * "Raw vs normalized data". Not persisted as its own table; a JSON
 * projection of it is stored in InboundWebhookEvent.normalizedPayload for
 * audit, and future non-TradingView signal sources can produce the same
 * shape.
 */
export interface NormalizedSignal {
  source: WebhookProvider;
  externalEventFingerprint: string;
  instrumentId: string;
  strategyId: string;
  strategyVersionId: string;
  direction: Direction;
  signalType: TradingViewSignalType;
  timeframe: Timeframe;
  barTimestamp: Date;
  receivedTimestamp: Date;
  priceContext: {
    open: Decimal;
    high: Decimal;
    low: Decimal;
    close: Decimal;
    volume: Decimal;
  };
  metadata: Record<string, unknown>;
}

/** Every JournalEventType this milestone can emit before a Setup exists, always correlated on the InboundWebhookEvent's own id. */
export const WEBHOOK_JOURNAL_EVENT_TYPES: readonly JournalEventType[] = [
  "WEBHOOK_RECEIVED",
  "WEBHOOK_NORMALIZED",
  "SIGNAL_ACCEPTED",
  "WEBHOOK_DUPLICATE_DETECTED",
  "WEBHOOK_REJECTED",
  "WEBHOOK_PROCESSING_FAILED",
];
