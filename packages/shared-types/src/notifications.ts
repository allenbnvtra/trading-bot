import { z } from "zod";
import { SKIP_REASONS } from "./enums";

export const NOTIFICATION_QUEUE = "notification-delivery";
export const SEND_NOTIFICATION_JOB = "send-notification";

/** Bumped whenever the READY trade-card's format changes in a way that
 * should not silently rewrite delivery history — mirrors
 * CHART_CONFIG_VERSION's role for screenshots. */
export const NOTIFICATION_TEMPLATE_VERSION = "1.0.0";

/** How long the notification worker waits for a PRE_TRADE screenshot to
 * reach READY before sending a text-only READY notification. See
 * docs/notifications.md "Screenshot attachment". */
export const NOTIFICATION_SCREENSHOT_WAIT_MS = 8_000;
export const NOTIFICATION_SCREENSHOT_POLL_INTERVAL_MS = 500;

/** Per-request timeout for outbound calls to the Telegram Bot API
 * (TelegramNotificationProvider). Without this, a hung TCP connection or a
 * stalled response would block the BullMQ job (and that worker slot)
 * indefinitely instead of failing fast into the TEMPORARY/retry path -
 * mirrors RENDER_READY_TIMEOUT_MS's role for screenshot rendering
 * (packages/shared-types/src/screenshot.ts). */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

/** Mirrors ScreenshotGenerationJobPayload's shape/role — the BullMQ job body
 * carries only the NotificationDelivery id; the worker loads everything else
 * (setup, notification type, provider) from the row itself. */
export interface SendNotificationJobPayload {
  notificationDeliveryId: string;
}

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

/**
 * The single-action "record what I actually did" endpoint backing the
 * dashboard's PAPER TRADE / I ENTERED THIS TRADE buttons: creates a
 * JournalTrade AND records its entry atomically (see
 * createAndRecordJournalTradeEntry in journal-trades.ts), so the dashboard
 * never has to sequence two API calls for one human action. executionMode
 * is deliberately restricted to PAPER|MANUAL_LIVE — BACKTEST is never
 * created through this path (see createJournalTradeSchema's own comment)
 * and SKIPPED goes through skipSetupSchema/POST /setups/:id/skip instead.
 */
export const executeSetupSchema = z.object({
  executionMode: z.enum(["PAPER", "MANUAL_LIVE"]),
  actualEntry: positiveDecimalString("actualEntry"),
  quantity: z.number().int().positive(),
  entryTimestamp: z.string().datetime(),
  actualFees: nonNegativeDecimalString("actualFees").optional(),
  actualSlippage: nonNegativeDecimalString("actualSlippage").optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type ExecuteSetupInput = z.infer<typeof executeSetupSchema>;

export const skipSetupSchema = z.object({
  reason: z.enum(SKIP_REASONS).optional(),
});
export type SkipSetupInput = z.infer<typeof skipSetupSchema>;

export const notificationListQuerySchema = z.object({
  setupId: z.string().uuid().optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/**
 * Whether the real Telegram provider is fully configured: TELEGRAM_ENABLED
 * must be exactly "true" AND both TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID must be
 * non-empty. Any one missing falls back to NOTIFICATION_MODE=console — never
 * a half-configured attempt at the real Telegram API. Shared between
 * apps/worker (notification-provider.factory.ts, which decides which
 * provider to construct) and apps/api (health.service.ts, which reports
 * providerEnabled) so the three-env-var check has exactly one implementation
 * — apps never import from each other, only from packages/*.
 */
export function isTelegramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELEGRAM_ENABLED === "true" && Boolean(env.TELEGRAM_BOT_TOKEN) && Boolean(env.TELEGRAM_CHAT_ID);
}
