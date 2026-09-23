/**
 * Repository-layer error classes. Milestone 1 had no need for these (every
 * failure was either "not found -> null" or a raw Prisma error); Milestone 2
 * introduces stateful transitions (Setup status, JournalTrade lifecycle)
 * that need typed, catchable errors instead of throwing plain Error/letting
 * a Prisma constraint violation leak through.
 */

/** Thrown when a repository function is asked to load an entity that does not exist. */
export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Thrown by transitionSetupStatus on any transition that isn't in the fixed
 * state-machine matrix (see docs/trade-journal-design.md / SETUP_STATUSES /
 * TERMINAL_SETUP_STATUSES) — a backward transition, a same-status no-op, or
 * any transition attempted out of a terminal status.
 */
export class SetupTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`invalid Setup status transition: ${from} -> ${to}`);
    this.name = "SetupTransitionError";
    Object.setPrototypeOf(this, SetupTransitionError.prototype);
  }
}

/**
 * Thrown by recordJournalTradeEntry/closeJournalTrade when called from the
 * wrong JournalTrade lifecycle state (e.g. closing a trade that was never
 * entered, or entering one that is already OPEN/CLOSED/SKIPPED).
 */
export class JournalTradeStateError extends Error {
  constructor(action: string, currentStatus: string, requiredStatus: string) {
    super(`cannot ${action}: JournalTrade status is ${currentStatus}, required ${requiredStatus}`);
    this.name = "JournalTradeStateError";
    Object.setPrototypeOf(this, JournalTradeStateError.prototype);
  }
}

/**
 * Thrown by markScreenshotGenerating/markScreenshotReady/markScreenshotFailed
 * when called from the wrong TradeScreenshot lifecycle state (mirrors
 * JournalTradeStateError exactly). Most importantly, this is what keeps a
 * READY row — immutable historical evidence, see the model-level comment on
 * TradeScreenshot in prisma/schema.prisma — from ever being re-marked.
 */
export class ScreenshotStateError extends Error {
  constructor(action: string, currentStatus: string, requiredStatus: string) {
    super(`cannot ${action}: TradeScreenshot status is ${currentStatus}, required ${requiredStatus}`);
    this.name = "ScreenshotStateError";
    Object.setPrototypeOf(this, ScreenshotStateError.prototype);
  }
}

/**
 * Thrown by requestOrRetryScreenshot when the setupId/tradeId/tradeSource/
 * type combination is malformed. The TradeScreenshot schema has no DB-level
 * CHECK constraint tying `type` to which of setupId vs tradeId/tradeSource
 * must be non-null (deliberately deferred to this repository layer — see
 * .claude/agents/data-engineer.md), so this is what actually rejects a
 * malformed combination rather than silently letting it through to Postgres.
 */
export class ScreenshotTargetError extends Error {
  constructor(reason: string) {
    super(`invalid TradeScreenshot target: ${reason}`);
    this.name = "ScreenshotTargetError";
    Object.setPrototypeOf(this, ScreenshotTargetError.prototype);
  }
}

/**
 * Thrown by markNotificationSending/Sent/Failed/Retrying when called from
 * the wrong NotificationDelivery lifecycle state (mirrors ScreenshotStateError
 * exactly). Same constructor signature: operation, actual status, expected
 * status.
 */
export class NotificationStateError extends Error {
  constructor(action: string, currentStatus: string, requiredStatus: string) {
    super(`cannot ${action}: NotificationDelivery status is ${currentStatus}, required ${requiredStatus}`);
    this.name = "NotificationStateError";
    Object.setPrototypeOf(this, NotificationStateError.prototype);
  }
}

/**
 * Thrown by createRiskCalculation when the Setup it targets has no
 * plannedStop and/or plannedTarget1 yet (Milestone 3: a TRADINGVIEW-sourced
 * setup can begin with only a candidate entry). A risk calculation is
 * mathematically undefined without a stop/target — this is a clear,
 * typed rejection rather than a null-dereference crash.
 */
export class SetupIncompletePlanError extends Error {
  constructor(setupId: string, missingFields: string[]) {
    super(
      `cannot calculate risk for Setup ${setupId}: missing ${missingFields.join(", ")} — this setup's trade plan is not fully specified yet`,
    );
    this.name = "SetupIncompletePlanError";
    Object.setPrototypeOf(this, SetupIncompletePlanError.prototype);
  }
}

/**
 * Thrown by createJournalTrade/createAndRecordJournalTradeEntry when the
 * insert violates the partial unique index
 * `JournalTrade_setupId_active_decision_key` (at most one JournalTrade with
 * status OPEN/PLANNED/SKIPPED per Setup — see that migration and the model
 * comment on JournalTrade in prisma/schema.prisma).
 *
 * This is the real, database-level backstop behind SetupService.execute()'s
 * and skip()'s existing app-level `findJournalTradeBySetupId` check-then-act
 * guard (see setup.service.ts): that guard closes a double-click/retry, but
 * only a genuine constraint closes a true concurrent race between two
 * simultaneous decisions for the same Setup. Deliberately carries only
 * `setupId`, not an action name or a caller-facing message — SetupService
 * already knows whether it is inside execute() or skip() and constructs the
 * exact same ConflictException message its fast-path check already throws
 * for this situation, so a caller cannot tell which layer caught the race.
 */
export class JournalTradeActiveDecisionConflictError extends Error {
  constructor(public readonly setupId: string) {
    super(`Setup ${setupId} already has an active/recorded JournalTrade decision (setupId unique index violation)`);
    this.name = "JournalTradeActiveDecisionConflictError";
    Object.setPrototypeOf(this, JournalTradeActiveDecisionConflictError.prototype);
  }
}

/**
 * Thrown by researchRepository.createResearchExperiment when the insert
 * violates the partial unique index `ResearchExperiment_hypothesis_final_
 * test_key` (at most one non-FAILED FINAL_TEST experiment per hypothesis
 * see that migration and the model comment on ResearchExperiment in
 * prisma/schema.prisma). Mirrors JournalTradeActiveDecisionConflictError's
 * role for the JournalTrade partial unique index: this is the real,
 * database-level backstop for the "a final-test dataset is not renewable"
 * rule documented in docs/research-methodology.md.
 */
export class FinalTestAlreadySpentError extends Error {
  constructor(public readonly hypothesisId: string) {
    super(
      `Hypothesis ${hypothesisId} already has a FINAL_TEST experiment in progress or completed. ` +
        "Per docs/research-methodology.md, a final-test dataset is not renewable; propose a new " +
        "hypothesis (a fork of this one) if a fresh final-test period is needed.",
    );
    this.name = "FinalTestAlreadySpentError";
    Object.setPrototypeOf(this, FinalTestAlreadySpentError.prototype);
  }
}

/**
 * Thrown by researchRepository.createResearchExperiment when the requested
 * datasetRole is asked for out of order (e.g. VALIDATION before a COMPLETED
 * RESEARCH experiment exists for the same hypothesis). Enforced in
 * application code, not the schema, because "COMPLETED" is a status value,
 * not something a database CHECK constraint can express across rows.
 */
export class ResearchStageOrderError extends Error {
  constructor(
    public readonly hypothesisId: string,
    public readonly requestedRole: string,
    public readonly reason: string,
  ) {
    super(`Cannot create a ${requestedRole} experiment for hypothesis ${hypothesisId}: ${reason}`);
    this.name = "ResearchStageOrderError";
    Object.setPrototypeOf(this, ResearchStageOrderError.prototype);
  }
}

/**
 * Thrown by the (future) ResearchService.assertWithinBudget before
 * enqueueing a new AgentExecution job, once a daily token/cost ceiling is
 * exceeded. Defined here now, alongside researchRepository.getTodayResearchSpend
 * which supplies the numbers it is checked against, even though no caller
 * throws it yet in this task.
 */
export class ResearchBudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`Research experiment budget exceeded: ${reason}`);
    this.name = "ResearchBudgetExceededError";
    Object.setPrototypeOf(this, ResearchBudgetExceededError.prototype);
  }
}
