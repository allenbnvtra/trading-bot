-- Tech-debt fix (Milestone 6 final review): close the real check-then-act
-- race in SetupService.execute()/skip() (see setup.service.ts and
-- findJournalTradeBySetupId in journal-trades.ts) with a genuine database
-- constraint, not just an application-level findFirst-then-create guard.
--
-- Scope is deliberately "at most one active/recorded decision per Setup",
-- not "at most one JournalTrade per Setup ever": a CLOSED trade must not
-- block a future different trade for the same setup from ever being
-- possible in principle, even though nothing in this codebase re-executes a
-- closed setup's trade today. OPEN/PLANNED/SKIPPED are the non-terminal-or-
-- just-recorded statuses that represent "a decision has been made and not
-- yet fully wound down" for a given Setup; CLOSED is excluded on purpose.
--
-- Postgres has no direct Prisma-schema syntax for a partial (WHERE-clause)
-- unique index, so this is a hand-written raw-SQL migration (the documented
-- approach: `prisma migrate dev --create-only`, then hand-edit).
CREATE UNIQUE INDEX "JournalTrade_setupId_active_decision_key"
ON "JournalTrade" ("setupId")
WHERE "status" IN ('OPEN', 'PLANNED', 'SKIPPED');
