import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import {
  inboundWebhookEventsRepository,
  notificationDeliveriesRepository,
  prisma,
  tradeScreenshotsRepository,
} from "@trading-copilot/database";
import {
  LocalDiskScreenshotStorage,
  resolveScreenshotStorageRoot,
  type ScreenshotStorage,
} from "@trading-copilot/screenshot-storage";
import { isTelegramConfigured } from "@trading-copilot/shared-types";

export interface TradingViewIngestionHealth {
  status: "ONLINE" | "DEGRADED" | "UNKNOWN";
  lastEventAt: string | null;
  lastSuccessfulProcessingAt: string | null;
}

export interface ScreenshotGenerationHealth {
  status: "HEALTHY" | "DEGRADED" | "UNKNOWN";
  lastSuccessfulScreenshotAt: string | null;
  recentFailureCount: number;
}

export interface NotificationHealth {
  status: "HEALTHY" | "DEGRADED" | "DISABLED" | "UNKNOWN";
  providerEnabled: boolean;
  lastSuccessfulNotificationAt: string | null;
  recentFailureCount: number;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  postgres: "up" | "down";
  redis: "up" | "down";
  tradingViewIngestion: TradingViewIngestionHealth;
  screenshotGeneration: ScreenshotGenerationHealth;
  screenshotStorage: "up" | "down";
  notifications: NotificationHealth;
}

/**
 * How far back countRecentFailedScreenshots looks for a FAILED row. Bounded
 * deliberately (see that function's doc comment in
 * trade-screenshots.ts) so a subsystem that recovered from a past incident
 * is not reported DEGRADED forever.
 */
const RECENT_FAILURE_WINDOW_MINUTES = 60;

/**
 * Whether Telegram is enabled at all, for the purposes of deciding between
 * DISABLED and everything else. Distinct from `isTelegramConfigured()`
 * (all three TELEGRAM_* env vars fully set) - NOTIFICATION_MODE=telegram
 * with an incomplete TELEGRAM_* configuration is a real misconfiguration
 * worth surfacing as DEGRADED/UNKNOWN rather than silently reported
 * DISABLED, mirroring the `providerEnabled` check in the Task 10 brief.
 */
function notificationModeIsTelegram(): boolean {
  return process.env.NOTIFICATION_MODE === "telegram";
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

  // Mirrors apps/api/src/screenshots/screenshot-storage.provider.ts exactly
  // (same env var, same LocalDiskScreenshotStorage, same
  // resolveScreenshotStorageRoot anchoring against the monorepo root
  // rather than this process's own cwd - see that file for the full
  // explanation), instantiated directly as a class property rather than
  // injected via HealthModule - the same choice already made above for
  // `redis`, so HealthService stays a plain dependency-status check with no
  // need to wire ScreenshotModule's DI token into a module that has
  // nothing else to do with screenshots.
  private readonly screenshotStorage: ScreenshotStorage = new LocalDiskScreenshotStorage(
    resolveScreenshotStorageRoot(process.env.SCREENSHOT_STORAGE_ROOT ?? "./storage/screenshots"),
  );

  async check(): Promise<HealthStatus> {
    const [postgresUp, redisUp, tradingViewIngestion, screenshotGeneration, screenshotStorageUp, notifications] =
      await Promise.all([
        this.checkPostgres(),
        this.checkRedis(),
        this.checkTradingViewIngestion(),
        this.checkScreenshotGeneration(),
        this.checkScreenshotStorage(),
        this.checkNotifications(),
      ]);

    // Folding tradingViewIngestion into the overall status: DEGRADED (the
    // most recent delivery ended in FAILED) is a real operational problem
    // worth surfacing, so it pulls the overall status to "degraded" even
    // when Postgres/Redis are both up. UNKNOWN (no webhook ever received
    // yet) is not - a freshly-seeded local dev environment with no
    // TradingView alerts fired yet is a perfectly healthy state, not a
    // degraded one. screenshotGeneration follows the identical rule: only
    // DEGRADED (a recent FAILED row exists) pulls the overall status down;
    // UNKNOWN (no screenshot ever generated yet) does not. notifications
    // follows the identical rule: only DEGRADED (a recent FAILED row
    // exists) pulls the overall status down; DISABLED (Telegram not
    // configured, a normal local-dev/console-mode state) and UNKNOWN
    // (Telegram configured but nothing sent yet) do not.
    const ingestionIsHealthy = tradingViewIngestion.status !== "DEGRADED";
    const screenshotGenerationIsHealthy = screenshotGeneration.status !== "DEGRADED";
    const notificationIsHealthy = notifications.status !== "DEGRADED";

    return {
      status:
        postgresUp &&
        redisUp &&
        ingestionIsHealthy &&
        screenshotGenerationIsHealthy &&
        screenshotStorageUp &&
        notificationIsHealthy
          ? "ok"
          : "degraded",
      postgres: postgresUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
      tradingViewIngestion,
      screenshotGeneration,
      screenshotStorage: screenshotStorageUp ? "up" : "down",
      notifications,
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
   * findMostRecentInboundWebhookEvent (backed by the plain `[receivedAt]`
   * index, since this query has no `where` clause for a compound index's
   * leading column to filter on) and findMostRecentProcessedInboundWebhookEvent
   * (backed by `[processingStatus, receivedAt]`) - rather than listing every
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

  /**
   * Uses two dedicated indexed queries -
   * findMostRecentReadyScreenshot (backed by `[status, renderedAt]`) and
   * countRecentFailedScreenshots (backed by `[status, updatedAt]`) - rather
   * than listing every TradeScreenshot just to derive these two facts. See
   * packages/database/src/repositories/trade-screenshots.ts. Never claims
   * HEALTHY merely because the worker process that generates screenshots
   * exists or is running - the verdict comes only from real TradeScreenshot
   * rows, the same discipline checkTradingViewIngestion above already
   * applies to InboundWebhookEvent.
   */
  private async checkScreenshotGeneration(): Promise<ScreenshotGenerationHealth> {
    try {
      const [mostRecentReady, recentFailureCount] = await Promise.all([
        tradeScreenshotsRepository.findMostRecentReadyScreenshot(),
        tradeScreenshotsRepository.countRecentFailedScreenshots(RECENT_FAILURE_WINDOW_MINUTES),
      ]);

      if (!mostRecentReady && recentFailureCount === 0) {
        return { status: "UNKNOWN", lastSuccessfulScreenshotAt: null, recentFailureCount: 0 };
      }

      return {
        status: recentFailureCount > 0 ? "DEGRADED" : "HEALTHY",
        lastSuccessfulScreenshotAt: mostRecentReady?.renderedAt?.toISOString() ?? null,
        recentFailureCount,
      };
    } catch {
      return { status: "UNKNOWN", lastSuccessfulScreenshotAt: null, recentFailureCount: 0 };
    }
  }

  /**
   * Uses the same two-dedicated-indexed-query shape as
   * checkScreenshotGeneration -
   * findMostRecentSentNotificationOverall (backed by `[status, sentAt]`)
   * and countRecentFailedNotifications (backed by `[status, updatedAt]`) -
   * rather than listing every NotificationDelivery. See
   * packages/database/src/repositories/notification-deliveries.ts.
   *
   * DISABLED is reported before either query runs whenever Telegram is not
   * configured AND NOTIFICATION_MODE is not "telegram" - a normal local-dev
   * state (NOTIFICATION_MODE=console, no Telegram credentials) that is not
   * a health problem. Once past that gate, HEALTHY is never reported merely
   * because credentials exist (`providerEnabled: true`) - it requires a real
   * NotificationDelivery row that actually reached SENT. Configured-but-
   * nothing-sent-yet reports UNKNOWN, the same "no evidence yet, not
   * necessarily broken" verdict checkScreenshotGeneration gives an instrument
   * with no screenshots. A recent FAILED row always reports DEGRADED,
   * regardless of whether an earlier SENT row also exists.
   */
  private async checkNotifications(): Promise<NotificationHealth> {
    try {
      const providerEnabled = isTelegramConfigured();

      if (!providerEnabled && !notificationModeIsTelegram()) {
        return { status: "DISABLED", providerEnabled: false, lastSuccessfulNotificationAt: null, recentFailureCount: 0 };
      }

      const [mostRecentSent, recentFailureCount] = await Promise.all([
        notificationDeliveriesRepository.findMostRecentSentNotificationOverall(),
        notificationDeliveriesRepository.countRecentFailedNotifications(RECENT_FAILURE_WINDOW_MINUTES),
      ]);

      const status: NotificationHealth["status"] =
        recentFailureCount > 0 ? "DEGRADED" : mostRecentSent ? "HEALTHY" : "UNKNOWN";

      return {
        status,
        providerEnabled,
        lastSuccessfulNotificationAt: mostRecentSent?.sentAt?.toISOString() ?? null,
        recentFailureCount,
      };
    } catch {
      return { status: "UNKNOWN", providerEnabled: false, lastSuccessfulNotificationAt: null, recentFailureCount: 0 };
    }
  }

  /**
   * A real write+read+delete probe against the configured ScreenshotStorage,
   * not a hardcoded "up" - the same "real dependency status" discipline as
   * checkPostgres/checkRedis above. A uniquely-named probe key under a
   * dedicated `_health-probe/` prefix avoids any possibility of colliding
   * with a real screenshot's storage key. The delete is best-effort in a
   * `finally`: a failure to clean up the probe file must not itself flip an
   * otherwise-successful save+read verdict to "down".
   */
  private async checkScreenshotStorage(): Promise<boolean> {
    const probeKey = `_health-probe/${randomUUID()}.txt`;
    const payload = Buffer.from("health-check");
    try {
      await this.screenshotStorage.save(probeKey, payload, "text/plain");
      const readBack = await this.screenshotStorage.read(probeKey);
      return readBack.equals(payload);
    } catch {
      return false;
    } finally {
      try {
        await this.screenshotStorage.delete(probeKey);
      } catch {
        // Best-effort cleanup only; see doc comment above.
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
