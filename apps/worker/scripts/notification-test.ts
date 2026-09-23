/**
 * Safe, local-only development utility. Never expose this behavior over an
 * unauthenticated HTTP endpoint - see docs/notifications.md "Testing
 * Telegram locally". Run with:
 *   pnpm --filter @trading-copilot/worker notification:test
 */
import { createNotificationProvider, isTelegramConfigured } from "../src/notifications/notification-provider.factory";

async function main() {
  if (!isTelegramConfigured()) {
    console.log(
      "Telegram is not configured (TELEGRAM_ENABLED/TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not all set), so there is nothing to send. Set NOTIFICATION_MODE=telegram and all three TELEGRAM_* variables in .env to send a real test message.",
    );
    return;
  }
  const provider = createNotificationProvider();
  const result = await provider.send({
    text: "🔧 Trading Copilot notification:test. This is a manual verification message, not a real trade alert.",
    imageBuffer: null,
  });
  console.log(`Sent. externalMessageId=${result.externalMessageId}`);
}

main().catch((error) => {
  console.error("notification:test failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
