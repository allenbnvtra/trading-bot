import { Decimal } from "decimal.js";

/**
 * Every money/price/ratio column in prisma/schema.prisma's Milestone 2
 * journal tables is `@db.Decimal(18, 8)` — Postgres rounds to 8 decimal
 * places on write. Test-only helper so integration test expectations
 * compare against the same rounded precision the database actually
 * persists, rather than decimal.js's full (20 significant digit) precision.
 */
export function toDb8(value: Decimal): string {
  return value.toDecimalPlaces(8).toString();
}
