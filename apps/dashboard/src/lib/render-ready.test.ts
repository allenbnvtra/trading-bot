import { describe, expect, it, beforeEach } from "vitest";
import { setRenderReady, setRenderError, RENDER_STATE_ATTRIBUTE } from "./render-ready";

describe("render-ready contract", () => {
  beforeEach(() => {
    document.body.removeAttribute(RENDER_STATE_ATTRIBUTE);
    document.body.removeAttribute("data-render-error-code");
    document.body.removeAttribute("data-render-error-message");
  });

  it("setRenderReady sets the ready state Playwright polls for", () => {
    setRenderReady();
    expect(document.body.dataset.renderState).toBe("ready");
  });

  it("setRenderError sets the error state plus a readable code/message", () => {
    setRenderError("NO_CANDLES", "No candles available at or before the cutoff");
    expect(document.body.dataset.renderState).toBe("error");
    expect(document.body.dataset.renderErrorCode).toBe("NO_CANDLES");
    expect(document.body.dataset.renderErrorMessage).toBe("No candles available at or before the cutoff");
  });
});
