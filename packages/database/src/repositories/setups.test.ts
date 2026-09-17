import { describe, expect, it } from "vitest";
import { SETUP_STATUSES, TERMINAL_SETUP_STATUSES, type SetupStatus } from "@trading-copilot/shared-types";
import { isAllowedSetupTransition } from "./setups";

/**
 * Exhaustive check of the Setup status transition matrix (see
 * docs/trade-journal-design.md and .claude/agents/data-engineer.md): every
 * valid transition succeeds, every invalid one is rejected — including a
 * same-status no-op, every backward transition, and every transition
 * attempted out of a terminal status.
 */

const VALID_TRANSITIONS: Record<SetupStatus, readonly SetupStatus[]> = {
  WATCH: ["PREPARE", "READY", "REJECTED", "INVALIDATED", "EXPIRED"],
  PREPARE: ["READY", "REJECTED", "INVALIDATED", "EXPIRED"],
  READY: ["REJECTED", "INVALIDATED", "EXPIRED"],
  REJECTED: [],
  INVALIDATED: [],
  EXPIRED: [],
};

describe("isAllowedSetupTransition", () => {
  for (const from of SETUP_STATUSES) {
    for (const to of SETUP_STATUSES) {
      const shouldBeAllowed = VALID_TRANSITIONS[from].includes(to);
      it(`${shouldBeAllowed ? "allows" : "rejects"} ${from} -> ${to}`, () => {
        expect(isAllowedSetupTransition(from, to)).toBe(shouldBeAllowed);
      });
    }
  }

  it("rejects every same-status no-op", () => {
    for (const status of SETUP_STATUSES) {
      expect(isAllowedSetupTransition(status, status)).toBe(false);
    }
  });

  it("rejects every transition out of every terminal status", () => {
    for (const terminal of TERMINAL_SETUP_STATUSES) {
      for (const to of SETUP_STATUSES) {
        expect(isAllowedSetupTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("never allows a backward transition (READY -> WATCH, PREPARE -> WATCH, READY -> PREPARE)", () => {
    expect(isAllowedSetupTransition("READY", "WATCH")).toBe(false);
    expect(isAllowedSetupTransition("PREPARE", "WATCH")).toBe(false);
    expect(isAllowedSetupTransition("READY", "PREPARE")).toBe(false);
  });
});
