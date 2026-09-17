/**
 * Presentation-only formatting helpers.
 *
 * These functions never derive a financial value from other inputs. They
 * only change how an already-computed value (a decimal string from the API)
 * is displayed: thousands separators, fixed decimal places, percentage
 * notation, and date formatting.
 */

const MISSING = "N/A";

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

/** Formats a decimal string with thousands separators and fixed decimals. */
export function formatDecimal(value: string | null | undefined, decimals = 2): string {
  const num = toNumber(value);
  if (num === null) return MISSING;
  return num.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Formats a decimal string as currency-style, keeping the sign visible. */
export function formatCurrency(value: string | null | undefined, decimals = 2): string {
  const num = toNumber(value);
  if (num === null) return MISSING;
  const formatted = Math.abs(num).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return num < 0 ? `-$${formatted}` : `$${formatted}`;
}

/** Formats a 0-1 fraction (e.g. winRate) as a percentage string. */
export function formatPercent(value: string | null | undefined, decimals = 1): string {
  const num = toNumber(value);
  if (num === null) return MISSING;
  return `${(num * 100).toFixed(decimals)}%`;
}

/** Formats a value that is already expressed in percent units (e.g. maxDrawdownPercent). */
export function formatPercentValue(value: string | null | undefined, decimals = 1): string {
  const num = toNumber(value);
  if (num === null) return MISSING;
  return `${num.toFixed(decimals)}%`;
}

/** Formats an R multiple, e.g. "-1.01R". */
export function formatR(value: string | null | undefined, decimals = 2): string {
  const num = toNumber(value);
  if (num === null) return MISSING;
  return `${num.toFixed(decimals)}R`;
}

/**
 * Profit factor can legitimately be null (no losing trades). Never render
 * that as 0 or Infinity.
 */
export function formatProfitFactor(value: string | null | undefined, decimals = 2): string {
  const num = toNumber(value);
  if (num === null) return MISSING;
  return num.toFixed(decimals);
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  return value.toLocaleString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return MISSING;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return MISSING;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/**
 * Formats the elapsed time between two ISO timestamps, e.g. "340ms" or
 * "2.1s". This is a plain duration display, not a financial calculation -
 * both timestamps already come straight from the API.
 */
export function formatDurationBetween(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string {
  if (!startIso || !endIso) return MISSING;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return MISSING;
  const ms = end - start;
  if (ms < 0) return MISSING;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Returns "positive" | "negative" | "neutral" for styling already-computed values. */
export function signOf(value: string | null | undefined): "positive" | "negative" | "neutral" {
  const num = toNumber(value);
  if (num === null || num === 0) return "neutral";
  return num > 0 ? "positive" : "negative";
}
