import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { inboundWebhookEventsRepository, prisma } from "@trading-copilot/database";

export interface TradingViewIngestionHealth {
  status: "ONLINE" | "DEGRADED" | "UNKNOWN";
  lastEventAt: string | null;
  lastSuccessfulProcessingAt: string | null;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  postgres: "up" | "down";
  redis: "up" | "down";
  tradingViewIngestion: TradingViewIngestionHealth;
}

/**
 * Real dependency checks, not a hardcoded { status: "ok" }. A trivial
 * Postgres query and a Redis PING are cheap enough to run on every
 * /health request without needing caching. tradingViewIngestion (Milestone
 * 3) is derived the same way - from an actual query over
 * InboundWebhookEvent, never hardcoded to ONLINE.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  async check(): Promise<HealthStatus> {
    const [postgresUp, redisUp, tradingViewIngestion] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkTradingViewIngestion(),
    ]);

    // Folding tradingViewIngestion into the overall status: DEGRADED (the
    // most recent delivery ended in FAILED) is a real operational problem
    // worth surfacing, so it pulls the overall status to "degraded" even
    // when Postgres/Redis are both up. UNKNOWN (no webhook ever received
    // yet) is not - a freshly-seeded local dev environment with no
    // TradingView alerts fired yet is a perfectly healthy state, not a
    // degraded one.
    const ingestionIsHealthy = tradingViewIngestion.status !== "DEGRADED";

    return {
      status: postgresUp && redisUp && ingestionIsHealthy ? "ok" : "degraded",
      postgres: postgresUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
      tradingViewIngestion,
    };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  /**
   * Uses two dedicated indexed `take: 1` queries -
   * findMostRecentInboundWebhookEvent (backed by `[provider, receivedAt]`)
   * and findMostRecentProcessedInboundWebhookEvent (backed by
   * `[processingStatus, receivedAt]`) - rather than listing every
   * InboundWebhookEvent just to read the first one. See
   * packages/database/src/repositories/inbound-webhook-events.ts.
   */
  private async checkTradingViewIngestion(): Promise<TradingViewIngestionHealth> {
    try {
      const [mostRecent, lastSuccessful] = await Promise.all([
        inboundWebhookEventsRepository.findMostRecentInboundWebhookEvent(),
        inboundWebhookEventsRepository.findMostRecentProcessedInboundWebhookEvent(),
      ]);

      if (!mostRecent) {
        return { status: "UNKNOWN", lastEventAt: null, lastSuccessfulProcessingAt: null };
      }

      return {
        status: mostRecent.processingStatus === "FAILED" ? "DEGRADED" : "ONLINE",
        lastEventAt: mostRecent.receivedAt.toISOString(),
        lastSuccessfulProcessingAt: lastSuccessful?.processingCompletedAt?.toISOString() ?? null,
      };
    } catch {
      return { status: "UNKNOWN", lastEventAt: null, lastSuccessfulProcessingAt: null };
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
