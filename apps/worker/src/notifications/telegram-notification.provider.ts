import {
  NotificationProviderError,
  type NotificationMessage,
  type NotificationProvider,
  type NotificationSendResult,
} from "./notification-provider";

export interface TelegramNotificationProviderConfig {
  botToken: string;
  chatId: string;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

/**
 * Talks to the Telegram Bot API over plain `fetch` (no SDK).
 *
 * Never logs config.botToken. Never includes it in a thrown error's
 * message: every NotificationProviderError thrown here uses a fixed,
 * static message string and a failureCode drawn from a known, stable set
 * (see classify() below), never the raw provider response text, which
 * could in principle echo request details back.
 */
export class TelegramNotificationProvider implements NotificationProvider {
  constructor(private readonly config: TelegramNotificationProviderConfig) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    const method = message.imageBuffer ? "sendPhoto" : "sendMessage";
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;

    let response: Response;
    try {
      response = await this.doFetch(url, message);
    } catch {
      // Deliberately does not include the caught error's message: it may
      // contain request details (including the URL, which embeds the bot
      // token) depending on the fetch implementation/runtime.
      throw new NotificationProviderError("network error contacting Telegram", "TEMPORARY", "NETWORK_ERROR");
    }

    const body = (await response.json()) as TelegramApiResponse;

    if (!response.ok || !body.ok) {
      throw this.classify(response.status, body.description ?? "unknown Telegram API error");
    }

    return { externalMessageId: body.result ? String(body.result.message_id) : null };
  }

  private async doFetch(url: string, message: NotificationMessage): Promise<Response> {
    if (message.imageBuffer) {
      const form = new FormData();
      form.set("chat_id", this.config.chatId);
      form.set("caption", message.text);
      form.set("photo", new Blob([new Uint8Array(message.imageBuffer)], { type: "image/png" }), "screenshot.png");
      return fetch(url, { method: "POST", body: form });
    }
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.config.chatId, text: message.text }),
    });
  }

  /**
   * failureCode is always one of a fixed, known set below, never raw
   * provider text, so a bot token could never leak through an error's
   * failureCode field even if Telegram ever echoed request details back
   * in an error description.
   */
  private classify(status: number, description: string): NotificationProviderError {
    if (status === 401) {
      return new NotificationProviderError("Telegram rejected the bot token", "PERMANENT", "INVALID_BOT_TOKEN");
    }
    if (status === 429) {
      return new NotificationProviderError("Telegram rate limit exceeded", "TEMPORARY", "RATE_LIMITED");
    }
    if (status === 400 && /chat not found/i.test(description)) {
      return new NotificationProviderError("Telegram chat id not found", "PERMANENT", "INVALID_CHAT_ID");
    }
    if (status === 403) {
      return new NotificationProviderError(
        "Telegram bot lacks permission to message this chat",
        "PERMANENT",
        "PERMISSION_DENIED",
      );
    }
    if (status >= 500) {
      return new NotificationProviderError("Telegram server error", "TEMPORARY", "TELEGRAM_SERVER_ERROR");
    }
    return new NotificationProviderError("Telegram rejected the request", "PERMANENT", "MALFORMED_REQUEST");
  }
}
