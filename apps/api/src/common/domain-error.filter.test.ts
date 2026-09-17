import type { ArgumentsHost } from "@nestjs/common";
import { JournalTradeStateError, NotFoundError, SetupTransitionError } from "@trading-copilot/database";
import { describe, expect, it, vi } from "vitest";
import { DomainErrorFilter } from "./domain-error.filter";

function makeHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe("DomainErrorFilter", () => {
  const filter = new DomainErrorFilter();

  it("translates NotFoundError to a 404 response", () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundError("Setup", "missing-id"), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Setup not found: missing-id" }),
    );
  });

  it("translates SetupTransitionError to a 409 response", () => {
    const { host, status, json } = makeHost();
    filter.catch(new SetupTransitionError("REJECTED", "READY"), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "invalid Setup status transition: REJECTED -> READY" }),
    );
  });

  it("translates JournalTradeStateError to a 409 response", () => {
    const { host, status, json } = makeHost();
    filter.catch(new JournalTradeStateError("close", "PLANNED", "OPEN"), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "cannot close: JournalTrade status is PLANNED, required OPEN",
      }),
    );
  });
});
