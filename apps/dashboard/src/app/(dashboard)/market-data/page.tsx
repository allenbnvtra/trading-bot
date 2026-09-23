import { ApiError, getInstruments } from "@/lib/api";
import { formatDecimal } from "@/lib/format";
import MarketDataImportForm from "@/components/MarketDataImportForm";

export default async function MarketDataPage() {
  let instruments: Awaited<ReturnType<typeof getInstruments>> = [];
  let loadError: string | null = null;

  try {
    instruments = await getInstruments();
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load instruments.";
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Market Data</h1>
        <p>Instruments available for backtesting and their contract specifications.</p>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {!loadError && (
        <div className="card">
          <h2>Import Candles</h2>
          <MarketDataImportForm instruments={instruments} />
          <p className="muted">
            Equivalent curl command is documented in the repository README under
            &quot;Importing market data&quot;.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Instruments</h2>
        {!loadError && instruments.length === 0 && (
          <div className="empty-state">No instruments found.</div>
        )}
        {!loadError && instruments.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th>Asset Class</th>
                  <th>Exchange</th>
                  <th>Currency</th>
                  <th>Tick Size</th>
                  <th>Tick Value</th>
                  <th>Point Value</th>
                  <th>Commission / Contract</th>
                </tr>
              </thead>
              <tbody>
                {instruments.map((instrument) => (
                  <tr key={instrument.id}>
                    <td>{instrument.symbol}</td>
                    <td>{instrument.name}</td>
                    <td>{instrument.assetClass}</td>
                    <td>{instrument.exchange}</td>
                    <td>{instrument.currency}</td>
                    <td>{formatDecimal(instrument.tickSize, 4)}</td>
                    <td>{formatDecimal(instrument.tickValue, 4)}</td>
                    <td>{formatDecimal(instrument.pointValue, 4)}</td>
                    <td>{formatDecimal(instrument.commissionPerContract, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
