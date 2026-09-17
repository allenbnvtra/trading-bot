"use client";

import { useRef, useState } from "react";
import { ApiError, importMarketData, TIMEFRAMES, type Instrument, type MarketDataImportResult, type Timeframe } from "@/lib/api";

export default function MarketDataImportForm({ instruments }: { instruments: Instrument[] }) {
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? "");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MarketDataImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (instruments.length === 0) {
    return <div className="empty-state">Add an instrument before importing candle data.</div>;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CSV file to import.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("instrumentId", instrumentId);
      formData.append("timeframe", timeframe);
      formData.append("file", file);
      const importResult = await importMarketData(formData);
      setResult(importResult);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to import market data.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="md-instrument">Instrument</label>
          <select
            id="md-instrument"
            value={instrumentId}
            onChange={(event) => setInstrumentId(event.target.value)}
          >
            {instruments.map((instrument) => (
              <option key={instrument.id} value={instrument.id}>
                {instrument.symbol} ({instrument.exchange})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="md-timeframe">Timeframe</label>
          <select
            id="md-timeframe"
            value={timeframe}
            onChange={(event) => setTimeframe(event.target.value as Timeframe)}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="md-file">CSV File</label>
          <input id="md-file" type="file" accept=".csv,text/csv" ref={fileInputRef} />
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? "Importing..." : "Import"}
        </button>
      </div>

      {result && (
        <div className="detail-grid detail-grid--spaced">
          <div className="detail-item">
            <div className="detail-item__label">Rows Read</div>
            <div className="detail-item__value">{result.rowsRead}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Inserted</div>
            <div className="detail-item__value">{result.inserted}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Updated</div>
            <div className="detail-item__value">{result.updated}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Rejected</div>
            <div className="detail-item__value">{result.rejected}</div>
          </div>
          {result.errors.length > 0 && (
            <div className="detail-item detail-item--full">
              <div className="detail-item__label">Errors</div>
              <pre className="params">
                {result.errors.map((e) => `row ${e.row}: ${e.message}`).join("\n")}
              </pre>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
