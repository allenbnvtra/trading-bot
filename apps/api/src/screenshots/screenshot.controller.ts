import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Res } from "@nestjs/common";
import type { Response } from "express";
import { tradeScreenshotsRepository } from "@trading-copilot/database";
import type { ScreenshotStorage } from "@trading-copilot/screenshot-storage";
import { SCREENSHOT_STORAGE_TOKEN } from "./screenshot-storage.provider";

/**
 * The "controlled application route" the milestone brief calls for instead
 * of exposing the storage directory publicly (see docs/screenshot-design.md).
 * The client only ever supplies a screenshot id (validated as a UUID by
 * ParseUUIDPipe below); the real filesystem path (storageKey) always comes
 * from the TradeScreenshot row itself, read fresh from the database on every
 * request, and is never accepted from request input in any form - this
 * route can never be made to serve an arbitrary file.
 */
@Controller("screenshots")
export class ScreenshotController {
  constructor(@Inject(SCREENSHOT_STORAGE_TOKEN) private readonly storage: ScreenshotStorage) {}

  @Get(":id/image")
  async getImage(@Param("id", new ParseUUIDPipe()) id: string, @Res() res: Response): Promise<void> {
    const screenshot = await tradeScreenshotsRepository.getScreenshot(id);
    if (!screenshot || screenshot.status !== "READY" || !screenshot.storageKey || !screenshot.mimeType) {
      throw new NotFoundException(`No ready screenshot image for ${id}`);
    }

    const bytes = await this.storage.read(screenshot.storageKey);
    res.setHeader("Content-Type", screenshot.mimeType);
    res.send(bytes);
  }
}
