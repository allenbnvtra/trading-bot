import { chromium, type Browser, type Page } from "playwright";
import { Injectable } from "@nestjs/common";

/**
 * One long-lived Chromium instance shared across every screenshot job in
 * this worker process, launched lazily on first use rather than at
 * bootstrap (so a worker that never processes a screenshot job never pays
 * the browser-launch cost). Each job gets its own fresh page/context and
 * closes it when done - only the browser process itself is shared.
 */
@Injectable()
export class BrowserManager {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  async getPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const context = await browser.newContext();
    return context.newPage();
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
