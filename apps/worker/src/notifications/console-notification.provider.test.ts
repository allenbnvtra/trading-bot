import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleNotificationProvider } from "./console-notification.provider";

describe("ConsoleNotificationProvider", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns a synthetic, incrementing externalMessageId for each send", async () => {
    const provider = new ConsoleNotificationProvider();

    const first = await provider.send({ text: "first", imageBuffer: null });
    const second = await provider.send({ text: "second", imageBuffer: null });

    expect(first.externalMessageId).toBe("console-1");
    expect(second.externalMessageId).toBe("console-2");
  });

  it("logs the message text", async () => {
    const provider = new ConsoleNotificationProvider();

    await provider.send({ text: "hello world", imageBuffer: null });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("hello world"));
  });

  it("notes an attached image by byte length only, never dumping raw image bytes into the log", async () => {
    const provider = new ConsoleNotificationProvider();
    const imageBuffer = Buffer.from("fake-png-bytes-for-test");

    await provider.send({ text: "with image", imageBuffer });

    const loggedLine = logSpy.mock.calls[0]?.[0] as string;
    expect(loggedLine).toContain(`${imageBuffer.byteLength} bytes`);
    expect(loggedLine).not.toContain(imageBuffer.toString("base64"));
    expect(loggedLine).not.toContain(imageBuffer.toString());
  });

  it("omits any image note when imageBuffer is null", async () => {
    const provider = new ConsoleNotificationProvider();

    await provider.send({ text: "text only", imageBuffer: null });

    const loggedLine = logSpy.mock.calls[0]?.[0] as string;
    expect(loggedLine).not.toContain("image");
  });
});
