import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenshotController } from "./screenshot.controller";

vi.mock("@trading-copilot/database", () => ({
  tradeScreenshotsRepository: { getScreenshot: vi.fn() },
}));

import { tradeScreenshotsRepository } from "@trading-copilot/database";

beforeEach(() => {
  vi.clearAllMocks();
});

/** A minimal stub of Express's Response, just enough for getImage's byte-streaming path. */
function makeResponseStub() {
  return { setHeader: vi.fn(), send: vi.fn() };
}

describe("ScreenshotController.getImage", () => {
  it("streams image bytes for a READY screenshot", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1",
      status: "READY",
      storageKey: "setups/setup-1/pre-trade/1.0.0.png",
      mimeType: "image/png",
    } as never);
    const storage = { read: vi.fn().mockResolvedValue(Buffer.from("png-bytes")) };
    const controller = new ScreenshotController(storage as never);

    const res = makeResponseStub();
    await controller.getImage("s-1", res as never);

    expect(storage.read).toHaveBeenCalledWith("setups/setup-1/pre-trade/1.0.0.png");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(res.send).toHaveBeenCalledWith(Buffer.from("png-bytes"));
  });

  it("404s for a screenshot that is not yet READY", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1",
      status: "GENERATING",
    } as never);
    const storage = { read: vi.fn() };
    const controller = new ScreenshotController(storage as never);
    const res = makeResponseStub();

    await expect(controller.getImage("s-1", res as never)).rejects.toMatchObject({ status: 404 });
    expect(storage.read).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it("404s for a nonexistent screenshot id (never calls storage.read)", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue(null);
    const storage = { read: vi.fn() };
    const controller = new ScreenshotController(storage as never);
    const res = makeResponseStub();

    await expect(controller.getImage("missing", res as never)).rejects.toMatchObject({ status: 404 });
    expect(storage.read).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it("404s for a READY row that is missing storageKey/mimeType (defensive - should not happen in practice)", async () => {
    vi.mocked(tradeScreenshotsRepository.getScreenshot).mockResolvedValue({
      id: "s-1",
      status: "READY",
      storageKey: null,
      mimeType: null,
    } as never);
    const storage = { read: vi.fn() };
    const controller = new ScreenshotController(storage as never);
    const res = makeResponseStub();

    await expect(controller.getImage("s-1", res as never)).rejects.toMatchObject({ status: 404 });
    expect(storage.read).not.toHaveBeenCalled();
  });
});
