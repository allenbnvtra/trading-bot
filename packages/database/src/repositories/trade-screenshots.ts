import { Prisma } from "@prisma/client";
import type { ScreenshotType, TradeSource } from "@trading-copilot/shared-types";
import type { TradeScreenshot } from "@trading-copilot/trading-domain";
import { prisma } from "../client";
import { NotFoundError, ScreenshotStateError, ScreenshotTargetError } from "../errors";
import { mapTradeScreenshot } from "../mappers";
import { createJournalEvent } from "./journal-events";

/**
 * Milestone 5: real chart-screenshot generation lifecycle (see
 * docs/screenshot-design.md). Metadata only — the image itself lives in
 * object storage (packages/screenshot-storage), never as a blob in Postgres.
 *
 * A READY row is immutable historical evidence — see the model-level comment
 * on TradeScreenshot in prisma/schema.prisma. Nothing in this module ever
 * updates a READY row's own fields again.
 */

export interface RequestScreenshotInput {
  setupId: string | null;
  tradeId: string | null;
  tradeSource: TradeSource | null;
  type: ScreenshotType;
  marketSnapshotId: string | null;
  chartConfigVersion: string;
}

/**
 * Any Prisma client-shaped object that supports the `tradeScreenshot`
 * delegate — the top-level `prisma` singleton or a `$transaction` callback's
 * `tx` argument. Distinct from journal-events.ts's own `PrismaClientOrTx`
 * (which only exposes `journalEvent`) because `findByIdempotencyKey` below
 * needs to run both inside a transaction and, on the P2002 retry path,
 * against the top-level client. Named distinctly from journal-events.ts's
 * type of the same shortened name to avoid confusing the two incompatible
 * shapes for a reader jumping between files.
 */
type ScreenshotPrismaClientOrTx = Pick<Prisma.TransactionClient, "tradeScreenshot">;

/**
 * The TradeScreenshot schema has no DB-level CHECK constraint tying `type` to
 * which of setupId vs tradeId/tradeSource must be non-null (Task 1 review
 * note, deliberately deferred here) — exactly one of the two target key-pairs
 * must be provided, and it must agree with `type`:
 *   - setupId set, tradeId/tradeSource both null, type === "PRE_TRADE"
 *   - tradeId AND tradeSource set, setupId null, type === "POST_TRADE"
 * Every other combination (both, neither, a half-set trade pair, or a
 * type/target mismatch) is rejected here rather than allowed through to
 * Postgres, which has no constraint that would catch it.
 */
export function assertValidScreenshotTarget(input: RequestScreenshotInput): void {
  const hasSetupId = input.setupId !== null;
  const hasTradeId = input.tradeId !== null;
  const hasTradeSource = input.tradeSource !== null;

  if (hasTradeId !== hasTradeSource) {
    throw new ScreenshotTargetError(
      `tradeId and tradeSource must both be set or both be null (got tradeId=${String(input.tradeId)}, tradeSource=${String(input.tradeSource)})`,
    );
  }
  const hasTradeTarget = hasTradeId && hasTradeSource;

  if (hasSetupId === hasTradeTarget) {
    throw new ScreenshotTargetError(
      "must reference exactly one of setupId or (tradeId + tradeSource), not both or neither",
    );
  }

  if (hasSetupId && input.type !== "PRE_TRADE") {
    throw new ScreenshotTargetError(`a setupId-targeted screenshot must have type PRE_TRADE, got ${input.type}`);
  }

  if (hasTradeTarget && input.type !== "POST_TRADE") {
    throw new ScreenshotTargetError(`a trade-targeted screenshot must have type POST_TRADE, got ${input.type}`);
  }
}

function findByIdempotencyKey(tx: ScreenshotPrismaClientOrTx, input: RequestScreenshotInput) {
  return tx.tradeScreenshot.findFirst({
    where: input.setupId
      ? { setupId: input.setupId, type: input.type, chartConfigVersion: input.chartConfigVersion }
      : {
          tradeId: input.tradeId,
          tradeSource: input.tradeSource,
          type: input.type,
          chartConfigVersion: input.chartConfigVersion,
        },
  });
}

/**
 * Mirrors inbound-webhook-events.ts's isUniqueConstraintViolation exactly:
 * a type-safe P2002 check that also verifies the violated constraint is
 * actually the one this call cares about, rather than treating any P2002 on
 * the table as a match. `fields` is the full column list of one of
 * TradeScreenshot's two `@@unique` constraints (setup-keyed or
 * trade-keyed) — Postgres reports the violated constraint's columns in
 * `error.meta.target`.
 */
function isUniqueConstraintViolation(error: unknown, fields: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    fields.every((field) => (error.meta!.target as unknown[]).includes(field))
  );
}

/**
 * Idempotent per (setupId, type, chartConfigVersion) or (tradeId,
 * tradeSource, type, chartConfigVersion) — the same "database constraint, not
 * check-then-insert" pattern as InboundWebhookEvent.fingerprint (see
 * createInboundWebhookEvent in inbound-webhook-events.ts, which this mirrors
 * exactly). A pre-existing REQUESTED/GENERATING/READY row is returned as-is
 * (`alreadyInFlight: true`). A pre-existing FAILED row is reset to REQUESTED
 * and returned for reprocessing — this is the only mutation ever applied to
 * a non-terminal screenshot row's own fields, and it never touches a READY
 * row.
 *
 * `findFirst` then `create` is not race-free on its own — two concurrent
 * calls can both see no existing row and both attempt `create`. The two
 * `@@unique` constraints on TradeScreenshot are the actual safety net: the
 * loser's `create` throws P2002 inside the transaction. Since a failed
 * `prisma.$transaction` callback aborts that transaction, the P2002 is
 * caught *outside* it, and the loser re-reads the row the winner just
 * committed and returns that instead — never a second row, and never an
 * unhandled rejection out of this function.
 */
export async function requestOrRetryScreenshot(
  input: RequestScreenshotInput,
): Promise<{ screenshot: TradeScreenshot; alreadyInFlight: boolean }> {
  assertValidScreenshotTarget(input);

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await findByIdempotencyKey(tx, input);

      if (existing && existing.status !== "FAILED") {
        return { screenshot: mapTradeScreenshot(existing), alreadyInFlight: true };
      }

      if (existing) {
        const retried = await tx.tradeScreenshot.update({
          where: { id: existing.id },
          data: { status: "REQUESTED", failureCode: null, failureMessage: null },
        });
        return { screenshot: mapTradeScreenshot(retried), alreadyInFlight: false };
      }

      const created = await tx.tradeScreenshot.create({
        data: {
          setupId: input.setupId,
          tradeId: input.tradeId,
          tradeSource: input.tradeSource,
          type: input.type,
          marketSnapshotId: input.marketSnapshotId,
          chartConfigVersion: input.chartConfigVersion,
          status: "REQUESTED",
        },
      });

      await createJournalEvent(
        {
          eventType: "SCREENSHOT_REQUESTED",
          entityType: "TRADE_SCREENSHOT",
          entityId: created.id,
          correlationId: input.setupId ?? input.tradeId ?? created.id,
          metadata: { type: input.type, chartConfigVersion: input.chartConfigVersion },
        },
        tx,
      );

      return { screenshot: mapTradeScreenshot(created), alreadyInFlight: false };
    });
  } catch (error) {
    const constraintFields = input.setupId
      ? ["setupId", "type", "chartConfigVersion"]
      : ["tradeId", "tradeSource", "type", "chartConfigVersion"];
    if (!isUniqueConstraintViolation(error, constraintFields)) {
      throw error;
    }
    const winner = await findByIdempotencyKey(prisma, input);
    if (!winner) {
      // Unreachable in practice: a P2002 on these constraints guarantees a
      // matching row exists. Surface the original error rather than
      // fabricate one.
      throw error;
    }
    return { screenshot: mapTradeScreenshot(winner), alreadyInFlight: true };
  }
}

async function requireScreenshot(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.tradeScreenshot.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("TradeScreenshot", id);
  return row;
}

/**
 * Guarded with an atomic conditional `updateMany` rather than the
 * read-then-check-then-`update` pattern this module used to use. Under
 * Postgres READ COMMITTED (no `SELECT ... FOR UPDATE`, no isolation-level
 * override), a read-then-check-then-`update` by unique id alone lets two
 * concurrent transactions both read the same pre-transition status, both
 * pass the application-level guard, and both commit their `update` — the
 * second silently clobbers the first's already-committed row with no error
 * to either caller. `updateMany`'s `where` accepts an arbitrary filter
 * (unlike Prisma's typed `update()`, which only accepts a unique-field
 * `where`), and Postgres re-evaluates that filter against the row's
 * currently-committed state at execution time inside this transaction, not a
 * stale snapshot read earlier in the transaction — so only one of two
 * concurrent conditional updates can ever match and affect a row. A
 * `result.count === 0` means the guard failed (wrong state, or no such row);
 * the actual current state is then re-fetched to report accurately in the
 * thrown error, never guessed from the stale pre-update read.
 */
export async function markScreenshotGenerating(id: string): Promise<TradeScreenshot> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.tradeScreenshot.updateMany({
      where: { id, status: "REQUESTED" },
      data: { status: "GENERATING" },
    });
    if (result.count === 0) {
      const current = await requireScreenshot(tx, id);
      throw new ScreenshotStateError("mark generating", current.status, "REQUESTED");
    }
    const row = await tx.tradeScreenshot.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "SCREENSHOT_GENERATION_STARTED",
        entityType: "TRADE_SCREENSHOT",
        entityId: id,
        correlationId: row.setupId ?? row.tradeId ?? id,
        metadata: { type: row.type, chartConfigVersion: row.chartConfigVersion },
      },
      tx,
    );
    return mapTradeScreenshot(row);
  });
}

export interface MarkScreenshotReadyInput {
  storageProvider: string;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  renderedAt: Date;
}

/**
 * REQUESTED or GENERATING -> READY. Never READY -> READY: a READY row is
 * immutable historical evidence, so calling this on an already-READY row
 * must throw, not silently no-op or overwrite. Guarded with an atomic
 * conditional `updateMany` — see markScreenshotGenerating's doc comment for
 * why the previous read-then-check-then-`update` pattern was not actually
 * race-free under concurrency.
 */
export async function markScreenshotReady(
  id: string,
  input: MarkScreenshotReadyInput,
): Promise<TradeScreenshot> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.tradeScreenshot.updateMany({
      where: { id, status: { in: ["REQUESTED", "GENERATING"] } },
      data: {
        status: "READY",
        storageProvider: input.storageProvider,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        renderedAt: input.renderedAt,
      },
    });
    if (result.count === 0) {
      const current = await requireScreenshot(tx, id);
      throw new ScreenshotStateError("mark ready", current.status, "REQUESTED or GENERATING");
    }
    const row = await tx.tradeScreenshot.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "SCREENSHOT_CREATED",
        entityType: "TRADE_SCREENSHOT",
        entityId: id,
        correlationId: row.setupId ?? row.tradeId ?? id,
        metadata: { type: row.type, chartConfigVersion: row.chartConfigVersion },
      },
      tx,
    );
    return mapTradeScreenshot(row);
  });
}

export interface MarkScreenshotFailedInput {
  failureCode: string;
  failureMessage: string;
}

/**
 * REQUESTED or GENERATING -> FAILED. Guarded the same way as
 * markScreenshotReady — in particular, a READY row must never be flipped to
 * FAILED (it is immutable historical evidence, not a working record that can
 * be revoked after the fact). Also uses the atomic conditional `updateMany`
 * guard — see markScreenshotGenerating's doc comment for the concurrency
 * rationale. This closes the specific race the original read-then-check
 * guard did not: a straggling markScreenshotFailed call that read a stale
 * GENERATING snapshot before a racing markScreenshotReady call committed can
 * no longer flip an already-committed READY row back to FAILED, because the
 * `updateMany`'s WHERE clause is re-evaluated against the row's
 * currently-committed status at execution time, not the stale read.
 */
export async function markScreenshotFailed(
  id: string,
  input: MarkScreenshotFailedInput,
): Promise<TradeScreenshot> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.tradeScreenshot.updateMany({
      where: { id, status: { in: ["REQUESTED", "GENERATING"] } },
      data: { status: "FAILED", failureCode: input.failureCode, failureMessage: input.failureMessage },
    });
    if (result.count === 0) {
      const current = await requireScreenshot(tx, id);
      throw new ScreenshotStateError("mark failed", current.status, "REQUESTED or GENERATING");
    }
    const row = await tx.tradeScreenshot.findUniqueOrThrow({ where: { id } });
    await createJournalEvent(
      {
        eventType: "SCREENSHOT_FAILED",
        entityType: "TRADE_SCREENSHOT",
        entityId: id,
        correlationId: row.setupId ?? row.tradeId ?? id,
        metadata: { failureCode: input.failureCode },
      },
      tx,
    );
    return mapTradeScreenshot(row);
  });
}

export async function getScreenshot(id: string): Promise<TradeScreenshot | null> {
  const row = await prisma.tradeScreenshot.findUnique({ where: { id } });
  return row ? mapTradeScreenshot(row) : null;
}

export async function listScreenshotsForSetup(setupId: string): Promise<TradeScreenshot[]> {
  const rows = await prisma.tradeScreenshot.findMany({ where: { setupId }, orderBy: { createdAt: "asc" } });
  return rows.map(mapTradeScreenshot);
}

export async function listScreenshotsForTrade(
  tradeId: string,
  tradeSource: TradeSource,
): Promise<TradeScreenshot[]> {
  const rows = await prisma.tradeScreenshot.findMany({
    where: { tradeId, tradeSource },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapTradeScreenshot);
}

/**
 * The single most recent screenshot that reached READY, across every
 * setup/trade. Backed by the `[status, renderedAt]` index — an equality
 * filter on `status` with `take: 1` ordering on `renderedAt`, never a full
 * table scan. Mirrors findMostRecentProcessedInboundWebhookEvent in
 * inbound-webhook-events.ts, with one deliberate difference: `renderedAt`
 * is nullable in the schema, and this dev database in fact has a READY row
 * with a NULL `renderedAt` (caught manually, live, while building this
 * query — not a hypothetical). Postgres's default null-ordering for
 * `ORDER BY ... DESC` is NULLS FIRST, so a plain `.desc` here would have
 * put that NULL row ahead of every genuinely-dated one, silently reporting
 * the wrong "most recent" screenshot. `nulls: "last"` makes NULL sort as
 * the oldest, matching what "most recent by renderedAt" should mean.
 */
export async function findMostRecentReadyScreenshot(): Promise<TradeScreenshot | null> {
  const row = await prisma.tradeScreenshot.findFirst({
    where: { status: "READY" },
    orderBy: { renderedAt: { sort: "desc", nulls: "last" } },
  });
  return row ? mapTradeScreenshot(row) : null;
}

/**
 * Count of screenshots that transitioned to FAILED within the last
 * `sinceMinutesAgo` minutes (by `updatedAt`, the column
 * markScreenshotFailed's `updateMany` actually writes on that transition).
 * Backed by the `[status, updatedAt]` index — an equality filter on
 * `status` with a range filter on `updatedAt`, never a full table scan.
 * Deliberately bounded to a recent window rather than an all-time FAILED
 * count, so a subsystem that recovered from a past incident is not reported
 * DEGRADED forever. Used only by GET /health.
 */
export async function countRecentFailedScreenshots(sinceMinutesAgo: number): Promise<number> {
  const cutoff = new Date(Date.now() - sinceMinutesAgo * 60_000);
  return prisma.tradeScreenshot.count({
    where: { status: "FAILED", updatedAt: { gte: cutoff } },
  });
}
