import { ConflictException } from "@nestjs/common";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  instrumentsRepository,
  marketSnapshotsRepository,
  prisma,
  setupsRepository,
} from "@trading-copilot/database";
import type { Setup } from "@trading-copilot/trading-domain";
import { SetupService } from "./setup.service";

/**
 * Real Postgres, real (unmocked) SetupService.execute()/skip() - proves the
 * JournalTrade_setupId_active_decision_key partial unique index (migration
 * 20260923144150_add_journal_trade_active_decision_unique_index) actually
 * engages as a true concurrency-safety net behind SetupService's existing
 * app-level findJournalTradeBySetupId check-then-act guard, under genuine
 * concurrent execution (real Promise.allSettled, real Postgres) - not
 * simulated by mocking the repository to reject.
 *
 * Mirrors notification-idempotency.integration.test.ts's structure, but
 * deliberately exercises the SERVICE layer rather than just the repository:
 * the thing this file verifies is that SetupService.execute()/skip()
 * correctly translate a real P2002 constraint violation (surfaced as
 * JournalTradeActiveDecisionConflictError - see packages/database/src/
 * errors.ts) into the exact same ConflictException their fast-path check
 * already throws for this situation, so a caller can never distinguish a
 * double-click/retry rejection from a genuine race rejection.
 *
 * execute()/skip() never call ScreenshotService/NotificationService - only
 * updateStatus() does (see setup.service.ts) - so untyped stub objects for
 * SetupService's constructor are safe here: nothing on this code path ever
 * invokes them. Requires DATABASE_URL and the Milestone 1 seed
 * (`pnpm db:seed`), matching notification-idempotency.integration.test.ts's
 * convention exactly.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "SetupService.execute()/skip() active-decision race (live Postgres)",
  () => {
    function makeService(): SetupService {
      return new SetupService({} as never, {} as never);
    }

    async function seededReadySetup(testId: string): Promise<Setup> {
      const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
      if (!instrument) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

      const strategy = await prisma.strategy.findUnique({ where: { key: "ema-trend-pullback" } });
      if (!strategy) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

      const strategyVersion = await prisma.strategyVersion.findUnique({
        where: { strategyId_version: { strategyId: strategy.id, version: "1.0.0" } },
      });
      if (!strategyVersion) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

      const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
        instrumentId: instrument.id,
        timestamp: new Date(),
        timeframe: "1h",
        metadata: { test: testId },
      });

      const setup = await setupsRepository.createSetup({
        instrumentId: instrument.id,
        strategyId: strategy.id,
        strategyVersionId: strategyVersion.id,
        marketSnapshotId: snapshot.id,
        direction: "LONG",
        source: "MANUAL_TEST",
        plannedEntry: new Decimal("100"),
        plannedStop: new Decimal("95"),
        plannedTarget1: new Decimal("110"),
        metadata: { test: testId },
      });

      return setupsRepository.transitionSetupStatus(setup.id, { status: "READY", decisionSummary: null });
    }

    it("10 concurrent execute() calls against the same READY Setup converge on exactly one OPEN JournalTrade", async () => {
      const setup = await seededReadySetup("setup-active-decision-concurrency-execute");
      const service = makeService();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.execute(setup.id, {
            executionMode: "PAPER",
            actualEntry: "100.5",
            quantity: 1,
            entryTimestamp: new Date().toISOString(),
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(ConflictException);
        expect((r.reason as ConflictException).message).toBe(
          `Setup ${setup.id} already has a recorded trade decision (execute or skip) — cannot execute it again`,
        );
      }

      // Never more than the one row the DB constraint guarantees - the real
      // proof that this held under concurrency, not just that the app got a
      // 409 back.
      const rows = await prisma.journalTrade.findMany({ where: { setupId: setup.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("OPEN");
    });

    it("simultaneous execute() and skip() against the same READY Setup converge on exactly one JournalTrade", async () => {
      const setup = await seededReadySetup("setup-active-decision-concurrency-execute-vs-skip");
      const service = makeService();

      const [executeResult, skipResult] = await Promise.allSettled([
        service.execute(setup.id, {
          executionMode: "PAPER",
          actualEntry: "100.5",
          quantity: 1,
          entryTimestamp: new Date().toISOString(),
        }),
        service.skip(setup.id, { reason: "PRICE_MOVED" }),
      ]);

      const outcomes = [executeResult, skipResult];
      const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
      const rejected = outcomes.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);
      const rejectedMessage = (rejected[0]!.reason as ConflictException).message;
      expect(
        rejectedMessage ===
          `Setup ${setup.id} already has a recorded trade decision (execute or skip) — cannot execute it again` ||
          rejectedMessage ===
            `Setup ${setup.id} already has a recorded trade decision (execute or skip) — cannot skip it again`,
      ).toBe(true);

      const rows = await prisma.journalTrade.findMany({ where: { setupId: setup.id } });
      expect(rows).toHaveLength(1);
    });
  },
);
