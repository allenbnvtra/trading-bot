export interface NotificationMessage {
  text: string;
  imageBuffer: Buffer | null;
}

export interface NotificationSendResult {
  externalMessageId: string | null;
}

export type NotificationFailureKind = "TEMPORARY" | "PERMANENT";

/**
 * TEMPORARY errors are retried by BullMQ's own attempts/backoff (the
 * processor rethrows). PERMANENT errors are not: the processor marks the
 * NotificationDelivery FAILED and returns normally so the job completes
 * without further automatic retries (see notification-send.processor.ts).
 * failureCode is one of a known, stable set (see the Telegram provider's
 * classify function), never the raw provider error text, which could
 * theoretically embed the bot token in some Telegram error responses.
 */
export class NotificationProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: NotificationFailureKind,
    public readonly failureCode: string,
  ) {
    super(message);
    this.name = "NotificationProviderError";
  }
}

export interface NotificationProvider {
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}
