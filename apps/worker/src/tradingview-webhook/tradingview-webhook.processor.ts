import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import Decimal from "decimal.js";
import {
  inboundWebhookEventsRepository,
  marketSnapshotsRepository,
  setupsRepository,
  strategiesRepository,
  tradingViewInstrumentMappingsRepository,
} from "@trading-copilot/database";
import {
  SETUP_EXPIRATION_JOB,
  SETUP_EXPIRATION_QUEUE,
  TRADINGVIEW_WEBHOOK_QUEUE,
  normalizeTradingViewPayload,
  tradingViewWebhookV1Schema,
  type SetupExpirationJobPayload,
  type TradingViewWebhookJobPayload,
} from "@trading-copilot/shared-types";
import { publishRealtimeEvent } from "../common/realtime-publisher";

const WORKER_CONCURRENCY = process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 2;

/**
 * How long a TRADINGVIEW-sourced Setup lives before it auto-expires if a
 * human never actions it (docs/tradingview-setup.md "Setup expiration").
 * Read at call time (not module load) so tests can override it via
 * process.env without needing to reload the module.
 */
function getSetupExpiryMinutes(): number {
  return process.env.TRADINGVIEW_SETUP_EXPIRY_MINUTES
    ? Number(process.env.TRADINGVIEW_SETUP_EXPIRY_MINUTES)
    : 60;
}

/** Processing outcomes that must never be reprocessed - see the idempotency-on-retry comment on process() below. */
const ALREADY_RESOLVED_STATUSES = new Set(["PROCESSED", "REJECTED", "UNSUPPORTED"]);

/**
 * Consumes the "tradingview-webhook-event" queue's "process" jobs. The job
 * payload only ever carries { inboundWebhookEventId } - every other input
 * (raw payload, instrument, strategy version) is re-fetched from Postgres
 * here, so Postgres stays the single source of truth and a retried job can
 * never act on stale data (same principle as backtest-run.processor.ts).
 *
 * No backtesting/risk/strategy math lives in this file - the only
 * arithmetic here is `new Decimal(signal.priceContext.close)` for
 * plannedEntry, per CLAUDE.md.
 */
@Processor(TRADINGVIEW_WEBHOOK_QUEUE, { concurrency: WORKER_CONCURRENCY })
export class TradingViewWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(TradingViewWebhookProcessor.name);

  constructor(
    @InjectQueue(SETUP_EXPIRATION_QUEUE)
    private readonly setupExpirationQueue: Queue<SetupExpirationJobPayload>,
  ) {
    super();
  }

  async process(job: Job<TradingViewWebhookJobPayload>): Promise<void> {
    const { inboundWebhookEventId: id } = job.data;

    try {
      const existing = await inboundWebhookEventsRepository.getInboundWebhookEvent(id);
      if (!existing) {
        throw new Error(`InboundWebhookEvent ${id} not found`);
      }

      // Idempotency-on-retry: a BullMQ retry (e.g. after a transient
      // failure partway through a previous attempt) must never re-process
      // an event that already reached a terminal outcome - most
      // importantly, must never double-create a Setup or double-emit
      // SIGNAL_ACCEPTED/SETUP_CREATED for an event already PROCESSED.
      // REJECTED/UNSUPPORTED are included too since re-running those paths
      // would emit a second WEBHOOK_REJECTED journal event for no reason.
      // FAILED is deliberately excluded - that is exactly the status a
      // retry exists to move past.
      if (ALREADY_RESOLVED_STATUSES.has(existing.processingStatus)) {
        this.logger.log(
          `InboundWebhookEvent ${id} already reached a terminal outcome (${existing.processingStatus}); skipping reprocessing`,
        );
        return;
      }

      await inboundWebhookEventsRepository.markInboundWebhookEventProcessing(id);

      // Never trust a Json column's shape blindly across process
      // boundaries, even though this payload was already validated once at
      // ingestion (apps/api).
      const parsedPayload = tradingViewWebhookV1Schema.safeParse(existing.rawPayload);
      if (!parsedPayload.success) {
        const message = parsedPayload.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        await inboundWebhookEventsRepository.markInboundWebhookEventRejected(id, {
          failureCode: "MALFORMED_PAYLOAD",
          failureMessage: message,
        });
        return;
      }

      const normalized = normalizeTradingViewPayload(parsedPayload.data, existing.receivedAt);
      if (!normalized.ok) {
        await inboundWebhookEventsRepository.markInboundWebhookEventRejected(id, {
          failureCode: normalized.failureCode,
          failureMessage: normalized.message,
        });
        return;
      }
      const signal = normalized.signal;

      await inboundWebhookEventsRepository.emitWebhookNormalized(id);

      const instrument = await tradingViewInstrumentMappingsRepository.resolveInstrumentMapping(
        signal.exchange,
        signal.symbol,
      );
      if (!instrument) {
        await inboundWebhookEventsRepository.markInboundWebhookEventRejected(id, {
          failureCode: "UNKNOWN_INSTRUMENT",
          failureMessage: `No TradingViewInstrumentMapping for ${signal.exchange}/${signal.symbol}`,
        });
        return;
      }

      const resolvedStrategy = await strategiesRepository.findStrategyVersionByKeyAndVersion(
        signal.strategyKey,
        signal.strategyVersion,
      );
      if (!resolvedStrategy) {
        await inboundWebhookEventsRepository.markInboundWebhookEventRejected(id, {
          failureCode: "UNKNOWN_STRATEGY_VERSION",
          failureMessage: `No StrategyVersion for strategyKey "${signal.strategyKey}" version "${signal.strategyVersion}"`,
        });
        return;
      }
      const { strategy, strategyVersion } = resolvedStrategy;

      const barTimestamp = new Date(signal.barTimestamp);

      // Idempotency guard for Setup creation itself (distinct from the
      // ALREADY_RESOLVED_STATUSES check above, which only catches a retry
      // once the event reaches a terminal processingStatus). A worker crash
      // or thrown error can land the event at PROCESSING or FAILED - neither
      // blocks reprocessing - *after* a Setup has already been created for
      // it. Without this check, a retry would re-run normalization,
      // instrument/strategy resolution (both pure/idempotent, safe to
      // repeat), then create a *second* MarketSnapshot and *second* Setup
      // for the same physical webhook delivery, which is exactly the
      // duplicate-Setup outcome the fingerprint-uniqueness design exists to
      // prevent, just reached through a different path (retry, not
      // duplicate delivery). See Setup.sourceWebhookEventId's @unique
      // constraint in prisma/schema.prisma.
      let setup = await setupsRepository.findSetupBySourceWebhookEventId(id);
      const justCreated = !setup;

      if (!setup) {
        const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
          instrumentId: instrument.id,
          timestamp: barTimestamp,
          timeframe: signal.timeframe,
          metadata: { ...signal.priceContext },
        });

        setup = await setupsRepository.createSetup({
          instrumentId: instrument.id,
          strategyId: strategy.id,
          strategyVersionId: strategyVersion.id,
          marketSnapshotId: snapshot.id,
          direction: signal.direction,
          source: "TRADINGVIEW",
          plannedEntry: new Decimal(signal.priceContext.close),
          plannedStop: null,
          plannedTarget1: null,
          metadata: {
            inboundWebhookEventId: id,
            externalEventFingerprint: signal.externalEventFingerprint,
            tradingViewSignalMetadata: signal.metadata,
          },
          expiresAt: new Date(barTimestamp.getTime() + getSetupExpiryMinutes() * 60_000),
          sourceWebhookEventId: id,
        });

        await inboundWebhookEventsRepository.emitSignalAccepted(id, {
          setupId: setup.id,
          instrumentId: instrument.id,
          strategyId: strategy.id,
          strategyVersionId: strategyVersion.id,
        });
      } else {
        this.logger.log(
          `InboundWebhookEvent ${id} already has a Setup (${setup.id}) from a prior attempt; recovering without creating a duplicate`,
        );
      }

      // Scheduled before markInboundWebhookEventProcessed (not after, as an
      // earlier version of this file did): PROCESSED blocks any future
      // retry, so if the process crashed between these two steps with the
      // old ordering, the event would be permanently PROCESSED with no
      // expiration job ever scheduled - the Setup's own expiresAt would then
      // silently never be honored. Scheduling first means a crash here just
      // means a retry (or the justCreated/recovery branch above) schedules
      // it again; a duplicate delayed job is harmless, since
      // setup-expiration.processor.ts no-ops on an already-terminal Setup.
      const expiresAt = setup.expiresAt ?? new Date(barTimestamp.getTime() + getSetupExpiryMinutes() * 60_000);
      const delay = Math.max(0, expiresAt.getTime() - Date.now());
      await this.setupExpirationQueue.add(SETUP_EXPIRATION_JOB, { setupId: setup.id }, { delay });

      await inboundWebhookEventsRepository.markInboundWebhookEventProcessed(id, {
        normalizedPayload: signal as unknown as Record<string, unknown>,
        setupId: setup.id,
      });

      // Only announce "created" to the dashboard the first time - a recovery
      // replay reusing an existing Setup has nothing new to announce.
      if (!justCreated) {
        return;
      }

      await publishRealtimeEvent({
        type: "setup.created",
        timestamp: new Date().toISOString(),
        setupId: setup.id,
        instrumentId: instrument.id,
        status: setup.status,
        direction: setup.direction,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`InboundWebhookEvent ${id} processing failed: ${message}`);
      await inboundWebhookEventsRepository.markInboundWebhookEventFailed(id, {
        failureMessage: message,
        failureCode: "INTERNAL_ERROR",
      });
      throw error;
    }
  }
}
