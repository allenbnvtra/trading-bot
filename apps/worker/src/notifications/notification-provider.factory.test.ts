import { describe, expect, it } from "vitest";
import { ConsoleNotificationProvider } from "./console-notification.provider";
import { createNotificationProvider, isTelegramConfigured } from "./notification-provider.factory";
import { TelegramNotificationProvider } from "./telegram-notification.provider";

function env(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("createNotificationProvider", () => {
  it("returns ConsoleNotificationProvider when NOTIFICATION_MODE is unset", () => {
    expect(createNotificationProvider(env())).toBeInstanceOf(ConsoleNotificationProvider);
  });

  it("returns ConsoleNotificationProvider when NOTIFICATION_MODE is explicitly 'console'", () => {
    expect(createNotificationProvider(env({ NOTIFICATION_MODE: "console" }))).toBeInstanceOf(ConsoleNotificationProvider);
  });

  it("returns ConsoleNotificationProvider when NOTIFICATION_MODE is 'telegram' but TELEGRAM_ENABLED is not 'true'", () => {
    const provider = createNotificationProvider(
      env({
        NOTIFICATION_MODE: "telegram",
        TELEGRAM_ENABLED: "false",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    );
    expect(provider).toBeInstanceOf(ConsoleNotificationProvider);
  });

  it("returns ConsoleNotificationProvider when TELEGRAM_ENABLED is 'true' but the bot token is missing", () => {
    const provider = createNotificationProvider(
      env({ NOTIFICATION_MODE: "telegram", TELEGRAM_ENABLED: "true", TELEGRAM_CHAT_ID: "chat" }),
    );
    expect(provider).toBeInstanceOf(ConsoleNotificationProvider);
  });

  it("returns ConsoleNotificationProvider when TELEGRAM_ENABLED is 'true' but the chat id is missing", () => {
    const provider = createNotificationProvider(
      env({ NOTIFICATION_MODE: "telegram", TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "token" }),
    );
    expect(provider).toBeInstanceOf(ConsoleNotificationProvider);
  });

  it("returns TelegramNotificationProvider when NOTIFICATION_MODE is 'telegram' and fully configured", () => {
    const provider = createNotificationProvider(
      env({
        NOTIFICATION_MODE: "telegram",
        TELEGRAM_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat",
      }),
    );
    expect(provider).toBeInstanceOf(TelegramNotificationProvider);
  });

  it("never throws for any partial/missing Telegram configuration, even when NOTIFICATION_MODE requests telegram", () => {
    expect(() => createNotificationProvider(env({ NOTIFICATION_MODE: "telegram" }))).not.toThrow();
  });
});

describe("isTelegramConfigured", () => {
  it("is false when TELEGRAM_ENABLED is not 'true'", () => {
    expect(isTelegramConfigured(env({ TELEGRAM_ENABLED: "false", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }))).toBe(
      false,
    );
  });

  it("is false when either credential is missing", () => {
    expect(isTelegramConfigured(env({ TELEGRAM_ENABLED: "true", TELEGRAM_CHAT_ID: "c" }))).toBe(false);
    expect(isTelegramConfigured(env({ TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t" }))).toBe(false);
  });

  it("is true when enabled and both credentials are present", () => {
    expect(isTelegramConfigured(env({ TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }))).toBe(
      true,
    );
  });
});
