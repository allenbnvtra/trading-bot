import { Logger } from "@nestjs/common";
import type { NotificationMessage, NotificationProvider, NotificationSendResult } from "./notification-provider";

/**
 * NOTIFICATION_MODE=console: logs a sanitized representation (text only; an
 * attached image is noted by byte length, never dumped as binary/base64
 * into logs) and returns a synthetic externalMessageId. Used for local
 * development with no Telegram credentials, and exclusively by every
 * automated test that exercises the send pipeline end-to-end (never the
 * real Telegram provider).
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(ConsoleNotificationProvider.name);
  private counter = 0;

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    this.counter += 1;
    const imageNote = message.imageBuffer ? ` [+image, ${message.imageBuffer.byteLength} bytes]` : "";
    this.logger.log(`[console-notification #${this.counter}] ${message.text}${imageNote}`);
    return { externalMessageId: `console-${this.counter}` };
  }
}
