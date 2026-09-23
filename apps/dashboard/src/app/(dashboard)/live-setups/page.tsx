import Link from "next/link";
import {
  ApiError,
  getInstruments,
  getMarketSnapshot,
  getSetups,
  type MarketSnapshot,
  type Setup,
} from "@/lib/api";
import { getAllStrategyVersions } from "@/lib/strategy-versions";
import HealthIndicator from "@/components/HealthIndicator";
import LiveSetupsClient from "./LiveSetupsClient";

/**
 * Fetches the MarketSnapshot linked to each Setup (a Setup doesn't carry
 * timeframe/bar-time itself - see packages/trading-domain's Setup /
 * MarketSnapshot). Deduplicated by marketSnapshotId since several Setups
 * can in principle share one snapshot, and fetched with Promise.all since
 * this is a small, personal-tool-scale list, not a paginated firehose.
 */
async function getSnapshotsForSetups(setups: Setup[]): Promise<Record<string, MarketSnapshot>> {
  const uniqueIds = [...new Set(setups.map((setup) => setup.marketSnapshotId))];
  const snapshots = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        return await getMarketSnapshot(id);
      } catch {
        // A snapshot fetch failing never blocks rendering the Setup itself -
        // the row simply shows "unknown" for timeframe/bar time.
        return null;
      }
    }),
  );
  const byId: Record<string, MarketSnapshot> = {};
  for (const snapshot of snapshots) {
    if (snapshot) byId[snapshot.id] = snapshot;
  }
  return byId;
}

export default async function LiveSetupsPage() {
  let loadError: string | null = null;
  let setups: Setup[] = [];
  let snapshotsById: Record<string, MarketSnapshot> = {};
  let instrumentLabels: Record<string, string> = {};
  let strategyVersionLabels: Record<string, string> = {};

  try {
    const [instruments, strategyVersions, fetchedSetups] = await Promise.all([
      getInstruments(),
      getAllStrategyVersions(),
      getSetups({ source: "TRADINGVIEW" }),
    ]);

    instrumentLabels = Object.fromEntries(
      instruments.map((instrument) => [instrument.id, instrument.symbol]),
    );
    strategyVersionLabels = Object.fromEntries(
      strategyVersions.map((version) => [version.id, `${version.strategyName} - ${version.version}`]),
    );
    setups = fetchedSetups;
    snapshotsById = await getSnapshotsForSetups(setups);
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load live setups.";
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Live Setups</h1>
        <p>
          TradingView alerts arriving as candidate Setups, updated live. See{" "}
          <Link href="/webhook-events">Webhook Events</Link> for the raw ingestion admin view.
        </p>
      </div>

      <HealthIndicator />

      {loadError && (
        <div className="card">
          <div className="error-banner">{loadError}</div>
        </div>
      )}

      {!loadError && (
        <LiveSetupsClient
          initialSetups={setups}
          initialSnapshots={snapshotsById}
          instrumentLabels={instrumentLabels}
          strategyVersionLabels={strategyVersionLabels}
        />
      )}
    </div>
  );
}
