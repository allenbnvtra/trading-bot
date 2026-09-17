import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupExpirationJobPayload } from "@trading-copilot/shared-types";
import { SetupExpirationProcessor } from "./setup-expiration.processor";

const { setupsRepository, publishRealtimeEvent } = vi.hoisted(() => ({
  setupsRepository: { getSetup: vi.fn(), transitionSetupStatus: vi.fn() },
  publishRealtimeEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@trading-copilot/database", () => ({ setupsRepository }));
vi.mock("../common/realtime-publisher", () => ({ publishRealtimeEvent }));

function makeJob(setupId: string): Job<SetupExpirationJobPayload> {
  return { data: { setupId } } as Job<SetupExpirationJobPayload>;
}

describe("SetupExpirationProcessor", () => {
  let processor: SetupExpirationProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new SetupExpirationProcessor();
  });

  it("no-ops when the Setup no longer exists", async () => {
    setupsRepository.getSetup.mockResolvedValue(null);

    await processor.process(makeJob("setup-missing"));

    expect(setupsRepository.transitionSetupStatus).not.toHaveBeenCalled();
    expect(publishRealtimeEvent).not.toHaveBeenCalled();
  });

  it.each(["REJECTED", "INVALIDATED", "EXPIRED"] as const)(
    "never overwrites an already-terminal status (%s)",
    async (status) => {
      setupsRepository.getSetup.mockResolvedValue({ id: "setup-1", status });

      await processor.process(makeJob("setup-1"));

      expect(setupsRepository.transitionSetupStatus).not.toHaveBeenCalled();
      expect(publishRealtimeEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["WATCH", "PREPARE", "READY"] as const)(
    "transitions a non-terminal Setup (%s) to EXPIRED and publishes setup.expired",
    async (status) => {
      setupsRepository.getSetup.mockResolvedValue({ id: "setup-1", status, instrumentId: "instrument-1" });
      setupsRepository.transitionSetupStatus.mockResolvedValue({
        id: "setup-1",
        status: "EXPIRED",
        instrumentId: "instrument-1",
        direction: "LONG",
      });

      await processor.process(makeJob("setup-1"));

      expect(setupsRepository.transitionSetupStatus).toHaveBeenCalledWith("setup-1", {
        status: "EXPIRED",
      });
      expect(publishRealtimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "setup.expired", setupId: "setup-1", status: "EXPIRED" }),
      );
    },
  );
});
