import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramNotificationProvider } from "./telegram-notification.provider";

describe("TelegramNotificationProvider", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a text-only message via sendMessage when imageBuffer is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new TelegramNotificationProvider({ botToken: "fake-token", chatId: "123" });

    const result = await provider.send({ text: "hello", imageBuffer: null });

    expect(result.externalMessageId).toBe("42");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.telegram.org/botfake-token/sendMessage"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends a photo with caption via sendPhoto when imageBuffer is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 43 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new TelegramNotificationProvider({ botToken: "fake-token", chatId: "123" });

    const result = await provider.send({ text: "caption text", imageBuffer: Buffer.from("png-bytes") });

    expect(result.externalMessageId).toBe("43");
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("https://api.telegram.org/botfake-token/sendPhoto");
    expect(calledUrl).not.toContain("sendMessage");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.body).toBeInstanceOf(FormData);
  });

  it("classifies a 401 Unauthorized response as a PERMANENT NotificationProviderError (invalid bot token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "bad", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "PERMANENT",
      failureCode: "INVALID_BOT_TOKEN",
    });
  });

  it("classifies a 400 'chat not found' response as PERMANENT (invalid chat id)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
      }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "bad-chat" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "PERMANENT",
      failureCode: "INVALID_CHAT_ID",
    });
  });

  it("classifies a 429 Too Many Requests response as TEMPORARY (rate limit)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ ok: false, description: "Too Many Requests" }),
      }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "TEMPORARY",
      failureCode: "RATE_LIMITED",
    });
  });

  it("classifies a 403 Forbidden response as PERMANENT (permission denied)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }),
      }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "PERMANENT",
      failureCode: "PERMISSION_DENIED",
    });
  });

  it("classifies a 5xx response as TEMPORARY (Telegram server error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ ok: false, description: "Bad Gateway" }),
      }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "TEMPORARY",
      failureCode: "TELEGRAM_SERVER_ERROR",
    });
  });

  it("classifies an unrecognized 4xx response as PERMANENT (malformed request)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: message text is empty" }),
      }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "123" });
    await expect(provider.send({ text: "", imageBuffer: null })).rejects.toMatchObject({
      kind: "PERMANENT",
      failureCode: "MALFORMED_REQUEST",
    });
  });

  it("classifies a network-level fetch rejection (ECONNRESET-style) as TEMPORARY", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET")));
    const provider = new TelegramNotificationProvider({ botToken: "x", chatId: "123" });
    await expect(provider.send({ text: "x", imageBuffer: null })).rejects.toMatchObject({
      kind: "TEMPORARY",
      failureCode: "NETWORK_ERROR",
    });
  });

  it("never includes the bot token in a thrown error's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }),
    );
    const provider = new TelegramNotificationProvider({ botToken: "super-secret-token", chatId: "123" });

    let caught: unknown;
    try {
      await provider.send({ text: "x", imageBuffer: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("super-secret-token");
  });

  it("never includes the bot token in a thrown error's message on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED api.telegram.org/botsuper-secret-token/sendMessage")),
    );
    const provider = new TelegramNotificationProvider({ botToken: "super-secret-token", chatId: "123" });

    let caught: unknown;
    try {
      await provider.send({ text: "x", imageBuffer: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("super-secret-token");
  });
});
