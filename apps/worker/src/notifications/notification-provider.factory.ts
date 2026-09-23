import { isTelegramConfigured } from "@trading-copilot/shared-types";
import { ConsoleNotificationProvider } from "./console-notification.provider";
import type { NotificationProvider } from "./notification-provider";
import { TelegramNotificationProvider } from "./telegram-notification.provider";

// Re-exported so every existing import of isTelegramConfigured from this
// factory (apps/worker/scripts/notification-test.ts, this file's own
// tests) keeps working unchanged - the single source of truth lives in
// @trading-copilot/shared-types (also used directly by
// apps/api/src/health/health.service.ts), not duplicated here.
export { isTelegramConfigured };

/**
 * NOTIFICATION_MODE=console (or unset, with no Telegram config) never
 * requires credentials: see docs/notifications.md. NOTIFICATION_MODE
 * defaults to "console" precisely so local development works with a
 * completely empty .env for this subsystem. TELEGRAM_ENABLED must be
 * explicitly "true" AND both TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID must be
 * set for the real provider to be selected: any partial/missing
 * configuration falls back to console mode rather than crashing the
 * worker at startup.
 */
export function createNotificationProvider(env: NodeJS.ProcessEnv = process.env): NotificationProvider {
  const mode = env.NOTIFICATION_MODE ?? "console";
  if (mode === "console") {
    return new ConsoleNotificationProvider();
  }

  const enabled = env.TELEGRAM_ENABLED === "true";
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!enabled || !botToken || !chatId) {
    return new ConsoleNotificationProvider();
  }

  return new TelegramNotificationProvider({ botToken, chatId });
}
