/**
 * REALTIME_CORS_ORIGIN is unset (or empty) in local development, which
 * keeps the gateway permissive (`origin: true`, matching the prior
 * hardcoded default — see docs/tradingview-security.md "Local development
 * vs. production"). In production, set it to a comma-separated list of
 * exact origins the dashboard is served from; nothing here guesses a
 * default production origin.
 */
export function parseRealtimeCorsOrigin(envValue: string | undefined): true | string[] {
  const trimmed = envValue?.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.split(",").map((origin) => origin.trim());
}
