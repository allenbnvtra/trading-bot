import Decimal from "decimal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  instrumentsRepository,
  marketSnapshotsRepository,
  setupsRepository,
  strategiesRepository,
} from "@trading-copilot/database";
import { SetupExpirationProcessor } from "./setup-expiration.processor";

const { publishRealtimeEvent } = vi.hoisted(() => ({
  publishRealtimeEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../common/realtime-publisher", () => ({ publishRealtimeEvent }));

/**
 * Real end-to-end exercise of the expiration processor against a live
 * Postgres database: creates a genuine TRADINGVIEW-sourced Setup (via the
 * real setupsRepository, using the Milestone 1 seed's GENFUT1 instrument
 * and ema-trend-pullback/1.0.0 strategy version, same convention as
 * packages/database's own integration tests) and transitions it for real.
 */
describe.skipIf(!process.env.DATABASE_URL)("SetupExpirationProcessor (live Postgres)", () => {
  let processor: SetupExpirationProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new SetupExpirationProcessor();
  });

  async function createTestSetup() {
    const instrument = await instrumentsRepository.findInstrumentBySymbolAndExchange("GENFUT1", "SIM-FUT");
    if (!instrument) throw new Error("expected the Milestone 1 seed to have run (pnpm db:seed)");

    const resolved = await strategiesRepository.findStrategyVersionByKeyAndVersion(
      "ema-trend-pullback",
      "1.0.0",
    );
    if (!resolved) throw new Error("expected the seeded ema-trend-pullback/1.0.0 strategy version");

    const snapshot = await marketSnapshotsRepository.createMarketSnapshot({
      instrumentId: instrument.id,
      timestamp: new Date(),
      timeframe: "5m",
      metadata: { integrationTest: true },
    });

    return setupsRepository.createSetup({
      instrumentId: instrument.id,
      strategyId: resolved.strategy.id,
      strategyVersionId: resolved.strategyVersion.id,
      marketSnapshotId: snapshot.id,
      direction: "LONG",
      source: "TRADINGVIEW",
      plannedEntry: new Decimal("100"),
      metadata: { integrationTest: true },
    });
  }

  it("transitions a live WATCH Setup to EXPIRED and publishes setup.expired", async () => {
    const setup = await createTestSetup();

    await processor.process({ data: { setupId: setup.id } } as never);

    const updated = await setupsRepository.getSetup(setup.id);
    expect(updated?.status).toBe("EXPIRED");
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "setup.expired", setupId: setup.id, status: "EXPIRED" }),
    );
  });

  it("never overwrites an already-terminal Setup (e.g. a human rejected it before the delay elapsed)", async () => {
    const setup = await createTestSetup();
    await setupsRepository.transitionSetupStatus(setup.id, { status: "REJECTED" });

    await processor.process({ data: { setupId: setup.id } } as never);

    const updated = await setupsRepository.getSetup(setup.id);
    expect(updated?.status).toBe("REJECTED");
    expect(publishRealtimeEvent).not.toHaveBeenCalled();
  });
});
