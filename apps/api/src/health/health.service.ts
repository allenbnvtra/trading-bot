import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { prisma } from "@trading-copilot/database";

export interface HealthStatus {
  status: "ok" | "degraded";
  postgres: "up" | "down";
  redis: "up" | "down";
}

/**
 * Real dependency checks, not a hardcoded { status: "ok" }. A trivial
 * Postgres query and a Redis PING are cheap enough to run on every
 * /health request without needing caching.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  async check(): Promise<HealthStatus> {
    const [postgresUp, redisUp] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    return {
      status: postgresUp && redisUp ? "ok" : "degraded",
      postgres: postgresUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
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

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
