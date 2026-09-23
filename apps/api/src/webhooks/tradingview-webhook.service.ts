import { createHash } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from "@nestjs/common";
import type { Queue } from "bullmq";
import Redis from "ioredis";
import { inboundWebhookEventsRepository } from "@trading-copilot/database";
import {
  REALTIME_CHANNEL,
  SUPPORTED_TRADINGVIEW_SCHEMA_VERSION,
  TRADINGVIEW_WEBHOOK_JOB,
  TRADINGVIEW_WEBHOOK_QUEUE,
  computeTradingViewFingerprint,
  tradingViewWebhookEnvelopeSchema,
  tradingViewWebhookV1Schema,
  type InboundWebhookEventListQuery,
  type TradingViewWebhookJobPayload,
} from "@trading-copilot/shared-types";
import type { InboundWebhookEvent, JournalEvent } from "@trading-copilot/trading-domain";
import { createRedisConnectionOptions } from "../common/redis-connection";

/**
 * Orchestrates the validation funnel documented in docs/tradingview-setup.md
 * (see the milestone task's exact resolved design):
 *
 *  1. Envelope schema (schemaVersion + source only) invalid -> still
 *     durably stored (best-effort fingerprint/schemaVersion, same fallback
 *     pattern as case 2 below), immediately marked REJECTED with
 *     MALFORMED_PAYLOAD, but the HTTP response is still a fast, synchronous
 *     400 and the event is never queued. Every rejection reason must stay
 *     queryable per docs/trade-journal-design.md's "never deleted or hidden
 *     on rejection" guarantee - a fast 400 for the caller and a durable
 *     audit row are not in tension, so there is no reason to skip persisting
 *     just because the shape didn't parse.
 *  2. Envelope valid but schemaVersion unsupported -> durably stored,
 *     immediately marked UNSUPPORTED, 202, never queued.
 *  3. schemaVersion 1 but the full v1 shape is invalid -> same as case 1:
 *     durably stored, marked REJECTED with MALFORMED_PAYLOAD, still a
 *     synchronous 400, never queued.
 *  4. Valid v1 payload -> fingerprinted and persisted; a genuine duplicate
 *     is never re-queued, a fresh event is queued for apps/worker.
 *
 * Controllers stay thin (CLAUDE.md); this service is the "call a domain
 * package or service" step for this one route family. No backtesting/risk
 * math exists anywhere in this file.
 */
export interface IngestWebhookResult {
  id: string;
  processingStatus: string;
  wasDuplicate?: true;
}

@Injectable()
export class TradingViewWebhookService implements OnModuleDestroy {
  private readonly logger = new Logger(TradingViewWebhookService.name);

  // A second, plain ioredis client (distinct from BullMQ's own connection)
  // used only to publish "webhook.received" onto the realtime pub/sub
  // channel apps/api's WebSocket gateway also subscribes to. See
  // docs/tradingview-setup.md "Realtime" for why this is published here
  // rather than deferred to apps/worker: the InboundWebhookEvent is created
  // in this process, and publishing right after that keeps "a new webhook
  // arrived" latency-independent of the BullMQ job actually being picked up.
  private readonly publisher = new Redis(createRedisConnectionOptions());

  constructor(
    @InjectQueue(TRADINGVIEW_WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue<TradingViewWebhookJobPayload>,
  ) {}

  async ingestWebhook(rawBody: unknown): Promise<IngestWebhookResult> {
    const envelopeResult = tradingViewWebhookEnvelopeSchema.safeParse(rawBody);
    if (!envelopeResult.success) {
      const issues = envelopeResult.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      this.logger.warn(
        `Rejected TradingView webhook: invalid envelope. issues=${JSON.stringify(issues)}`,
      );
      await this.persistMalformedRejection(rawBody, issues);
      throw new BadRequestException({ message: "Validation failed", issues });
    }
    const envelope = envelopeResult.data;

    if (envelope.schemaVersion !== SUPPORTED_TRADINGVIEW_SCHEMA_VERSION) {
      return this.handleUnsupportedSchemaVersion(rawBody as Record<string, unknown>, envelope.schemaVersion);
    }

    const v1Result = tradingViewWebhookV1Schema.safeParse(rawBody);
    if (!v1Result.success) {
      const issues = v1Result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      this.logger.warn(
        `Rejected TradingView webhook: invalid schemaVersion 1 payload. issueCount=${issues.length}`,
      );
      await this.persistMalformedRejection(rawBody, issues, envelope.schemaVersion);
      throw new BadRequestException({ message: "Validation failed", issues });
    }
    const payload = v1Result.data;

    const fingerprint = computeTradingViewFingerprint(payload);
    const { event, wasDuplicate } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion: 1,
      rawPayload: payload,
      fingerprint,
    });

    if (wasDuplicate) {
      return { id: event.id, processingStatus: event.processingStatus, wasDuplicate: true };
    }

    await inboundWebhookEventsRepository.markInboundWebhookEventQueued(event.id);
    // jobId: event.id is the id apps/worker's WebhookReconciliationProcessor
    // looks up (via queue.getJob) when reconciling a stale event, so it can
    // find this exact job and act on its actual state (retry if failed,
    // skip if still in flight, warn if already completed) rather than
    // blindly re-adding — see that processor's doc comment for the full
    // decision table and why a bare jobId-dedup add() alone isn't enough.
    await this.webhookQueue.add(
      TRADINGVIEW_WEBHOOK_JOB,
      { inboundWebhookEventId: event.id },
      { jobId: event.id },
    );
    await this.publishWebhookReceived(event);

    return { id: event.id, processingStatus: "QUEUED" };
  }

  private async handleUnsupportedSchemaVersion(
    rawBody: Record<string, unknown>,
    schemaVersion: number,
  ): Promise<IngestWebhookResult> {
    // computeTradingViewFingerprint requires v1-only fields that an
    // unsupported schema version's payload may not have at all, so a
    // fallback fingerprint (a plain hash of the whole body) is used
    // instead, purely to satisfy the unique-constraint column - it carries
    // no idempotency meaning across different schema versions/shapes.
    const fingerprint = createHash("sha256").update(JSON.stringify(rawBody)).digest("hex");
    const failureMessage = `Unsupported schemaVersion ${schemaVersion}; only ${SUPPORTED_TRADINGVIEW_SCHEMA_VERSION} is understood by this codebase`;

    const { event, wasDuplicate } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
      provider: "TRADINGVIEW",
      schemaVersion,
      rawPayload: rawBody,
      fingerprint,
    });

    // A repeat delivery of the identical unsupported-schema body is already
    // UNSUPPORTED from its first delivery; re-marking it would overwrite
    // processingCompletedAt and emit a redundant WEBHOOK_REJECTED event for
    // no benefit, same idempotency principle as the v1 path above.
    if (wasDuplicate) {
      return { id: event.id, processingStatus: event.processingStatus, wasDuplicate: true };
    }

    const unsupported = await inboundWebhookEventsRepository.markInboundWebhookEventUnsupported(event.id, {
      failureMessage,
    });

    return { id: unsupported.id, processingStatus: unsupported.processingStatus };
  }

  /**
   * Durably records a synchronous 400 rejection (envelope-invalid or
   * v1-shape-invalid) so it stays queryable, per
   * docs/trade-journal-design.md's "never deleted or hidden on rejection"
   * guarantee - MALFORMED_PAYLOAD is explicitly one of the codes that
   * guarantee covers. Uses the same fallback-fingerprint pattern as
   * handleUnsupportedSchemaVersion (a hash of the whole raw body): the
   * payload didn't pass even basic shape validation, so the real
   * field-based fingerprint (which needs specific v1 fields to exist and be
   * well-typed) cannot be computed. `schemaVersion` is best-effort: if the
   * raw body has a numeric-looking one, use it for record-keeping, otherwise
   * 0 (not a real version anyone would send) marks "could not even
   * determine a schema version." This never changes the HTTP response - the
   * caller still gets a fast, synchronous 400 either way; only an audit row
   * is added alongside it.
   */
  private async persistMalformedRejection(
    rawBody: unknown,
    issues: { path: string; message: string }[],
    knownSchemaVersion?: number,
  ): Promise<void> {
    try {
      const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
      const rawSchemaVersion = Number((body as { schemaVersion?: unknown }).schemaVersion);
      const schemaVersion = knownSchemaVersion ?? (Number.isFinite(rawSchemaVersion) ? rawSchemaVersion : 0);
      const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      const failureMessage = issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");

      const { event, wasDuplicate } = await inboundWebhookEventsRepository.createInboundWebhookEvent({
        provider: "TRADINGVIEW",
        schemaVersion,
        rawPayload: body,
        fingerprint,
      });

      // Same idempotency principle as the other rejection paths: a repeat
      // delivery of the identical malformed body is already recorded from
      // its first delivery, so this never re-marks it or emits a redundant
      // journal event.
      if (!wasDuplicate) {
        await inboundWebhookEventsRepository.markInboundWebhookEventRejected(event.id, {
          failureCode: "MALFORMED_PAYLOAD",
          failureMessage,
        });
      }
    } catch (error) {
      // Persisting the audit row is best-effort: a failure here must never
      // turn a client's already-correct 400 into a confusing 500. The
      // BadRequestException the caller sees is unaffected either way.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to persist a malformed-webhook rejection audit row: ${message}`);
    }
  }

  private async publishWebhookReceived(event: InboundWebhookEvent): Promise<void> {
    try {
      await this.publisher.publish(
        REALTIME_CHANNEL,
        JSON.stringify({
          type: "webhook.received",
          timestamp: new Date().toISOString(),
          webhookEventId: event.id,
          provider: event.provider,
        }),
      );
    } catch (error) {
      // Realtime notification is a presentation nicety, never the source of
      // truth (see docs/architecture.md) - a failed publish must never fail
      // webhook ingestion itself.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to publish webhook.received for event ${event.id}: ${message}`);
    }
  }

  async listEvents(query: InboundWebhookEventListQuery): Promise<InboundWebhookEvent[]> {
    return inboundWebhookEventsRepository.listInboundWebhookEvents({
      provider: query.provider,
      processingStatus: query.processingStatus,
      setupId: query.setupId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });
  }

  async getEvent(id: string): Promise<InboundWebhookEvent> {
    const event = await inboundWebhookEventsRepository.getInboundWebhookEvent(id);
    if (!event) {
      throw new NotFoundException(`InboundWebhookEvent ${id} not found`);
    }
    return event;
  }

  async getTimeline(id: string): Promise<JournalEvent[]> {
    // 404s first so a timeline request for a nonexistent event never
    // silently returns an empty array indistinguishable from "no events yet".
    await this.getEvent(id);
    return inboundWebhookEventsRepository.getFullTradingViewTimeline(id);
  }

  async onModuleDestroy(): Promise<void> {
    this.publisher.disconnect();
  }
}
