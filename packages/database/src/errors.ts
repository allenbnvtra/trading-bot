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
