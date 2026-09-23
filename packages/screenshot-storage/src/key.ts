const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[a-zA-Z0-9._-]+$/;

export interface BuildScreenshotStorageKeyInput {
  setupId: string | null;
  tradeId: string | null;
  tradeSource: "BACKTEST_TRADE" | "JOURNAL_TRADE" | null;
  type: "PRE_TRADE" | "POST_TRADE";
  chartConfigVersion: string;
}

/**
 * Generates a storage key internally from our own database-issued UUIDs —
 * never from arbitrary user input directly. Every segment is validated
 * against a strict allowlist regex before being interpolated into a path,
 * so even a caller passing an unexpected string can never traverse outside
 * the intended prefix (CLAUDE.md: never trust external input for
 * filesystem paths).
 */
export function buildScreenshotStorageKey(input: BuildScreenshotStorageKeyInput): string {
  if (!VERSION_RE.test(input.chartConfigVersion)) {
    throw new Error(`Invalid chartConfigVersion "${input.chartConfigVersion}" for a storage key`);
  }
  const typeSegment = input.type === "PRE_TRADE" ? "pre-trade" : "post-trade";

  if (input.setupId) {
    if (!UUID_RE.test(input.setupId)) {
      throw new Error(`setupId "${input.setupId}" is not a valid id`);
    }
    return `setups/${input.setupId}/${typeSegment}/${input.chartConfigVersion}.png`;
  }

  if (input.tradeId && input.tradeSource) {
    if (!UUID_RE.test(input.tradeId)) {
      throw new Error(`tradeId "${input.tradeId}" is not a valid id`);
    }
    const sourceSegment = input.tradeSource === "JOURNAL_TRADE" ? "journal-trade" : "backtest-trade";
    return `trades/${sourceSegment}/${input.tradeId}/${typeSegment}/${input.chartConfigVersion}.png`;
  }

  throw new Error("buildScreenshotStorageKey requires either setupId or tradeId+tradeSource");
}
