/**
 * The explicit render-ready contract Playwright polls for
 * (docs/screenshot-design.md "Render ready / error" - never an arbitrary
 * sleep). Both render routes (setup and trade) call exactly one of these,
 * exactly once, when the chart has finished drawing (or failed to).
 */
export const RENDER_STATE_ATTRIBUTE = "renderState";

export function setRenderReady(): void {
  document.body.dataset.renderState = "ready";
}

export function setRenderError(code: string, message: string): void {
  document.body.dataset.renderState = "error";
  document.body.dataset.renderErrorCode = code;
  document.body.dataset.renderErrorMessage = message;
}
