import { ApiError, getBacktests, getInstruments } from "@/lib/api";
import { getAllStrategyVersions } from "@/lib/strategy-versions";
import BacktestList, { type BacktestListLabels } from "@/components/BacktestList";
import CreateBacktestForm from "@/components/CreateBacktestForm";

export default async function ResearchPage() {
  let loadError: string | null = null;
  let instruments: Awaited<ReturnType<typeof getInstruments>> = [];
  let strategyVersions: Awaited<ReturnType<typeof getAllStrategyVersions>> = [];
  let backtests: Awaited<ReturnType<typeof getBacktests>> = [];

  try {
    [instruments, strategyVersions, backtests] = await Promise.all([
      getInstruments(),
      getAllStrategyVersions(),
      getBacktests(),
    ]);
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load research data.";
  }

  const labels: BacktestListLabels = {
    strategyVersionLabels: Object.fromEntries(
      strategyVersions.map((version) => [version.id, `${version.strategyName} - ${version.version}`]),
    ),
    instrumentLabels: Object.fromEntries(
      instruments.map((instrument) => [instrument.id, instrument.symbol]),
    ),
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Research</h1>
        <p>Run backtests and inspect strategy behavior and individual trades.</p>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {!loadError && (
        <div className="card">
          <h2>New Backtest</h2>
          <CreateBacktestForm instruments={instruments} strategyVersions={strategyVersions} />
        </div>
      )}

      <div className="card">
        <h2>Backtests</h2>
        {!loadError && <BacktestList backtests={backtests} labels={labels} />}
      </div>
    </div>
  );
}
