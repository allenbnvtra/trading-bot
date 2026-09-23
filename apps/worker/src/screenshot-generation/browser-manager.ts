import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Injectable } from "@nestjs/common";

/**
 * A Page plus the BrowserContext that owns it. Closing a Page alone does
 * NOT close its BrowserContext (confirmed directly against the installed
 * Playwright build: browser.contexts().length stayed non-zero across
 * repeated newContext -> newPage -> page.close() cycles) - the context
 * itself must be closed, or every screenshot job leaks a context for the
 * life of the worker process. Callers must close `context` (which also
 * closes `page` - no separate page.close() call is needed), never just
 * `page`.
 */
export interface ManagedPage {
  page: Page;
  context: BrowserContext;
}

/**
 * One long-lived Chromium instance shared across every screenshot job in
 * this worker process, launched lazily on first use rather than at
 * bootstrap (so a worker that never processes a screenshot job never pays
 * the browser-launch cost). Each job gets its own fresh context/page and
 * closes the context when done (see ManagedPage) - only the browser
 * process itself is shared.
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

  async getPage(): Promise<ManagedPage> {
    const browser = await this.getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    return { page, context };
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
