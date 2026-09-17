import { PrismaClient } from "@prisma/client";

/**
 * Singleton PrismaClient. In dev, `tsx --watch` / Next.js hot-reload can
 * re-execute this module many times per process; without caching the
 * instance on `globalThis` each reload would open a fresh pool of
 * connections against Postgres until it's exhausted. This is the standard
 * Next.js/Nest-safe singleton pattern.
 */
const globalForPrisma = globalThis as unknown as { __tradingCopilotPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__tradingCopilotPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__tradingCopilotPrisma = prisma;
}
