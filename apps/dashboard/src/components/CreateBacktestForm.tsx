"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  createBacktest,
  TIMEFRAMES,
  type Instrument,
  type Timeframe,
} from "@/lib/api";
import type { StrategyVersionWithStrategy } from "@/lib/strategy-versions";

export default function CreateBacktestForm({
  instruments,
  strategyVersions,
}: {
  instruments: Instrument[];
  strategyVersions: StrategyVersionWithStrategy[];
}) {
  const router = useRouter();

  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? "");
  const [strategyVersionId, setStrategyVersionId] = useState(strategyVersions[0]?.id ?? "");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [startDate, setStartDate] = useState("2024-01-01");
  const [endDate, setEndDate] = useState("2024-06-01");
  const [initialBalance, setInitialBalance] = useState("50000");
  const [riskPercentage, setRiskPercentage] = useState("1");
  const [slippageTicks, setSlippageTicks] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => instrumentId !== "" && strategyVersionId !== "" && !submitting,
    [instrumentId, strategyVersionId, submitting],
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createBacktest({
        instrumentId,
        strategyVersionId,
        timeframe,
        startDate: new Date(`${startDate}T00:00:00.000Z`).toISOString(),
        endDate: new Date(`${endDate}T00:00:00.000Z`).toISOString(),
        initialBalance,
        riskPercentage,
        slippageTicks: slippageTicks === "" ? undefined : Number(slippageTicks),
      });
      router.push(`/research/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create backtest.");
      setSubmitting(false);
    }
  }

  if (instruments.length === 0 || strategyVersions.length === 0) {
    return (
      <div className="empty-state">
        {instruments.length === 0
          ? "No instruments found. Import market data before running a backtest."
          : "No strategy versions found. Seed a strategy before running a backtest."}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="instrument">Instrument</label>
          <select
            id="instrument"
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
          <label htmlFor="strategyVersion">Strategy Version</label>
          <select
            id="strategyVersion"
            value={strategyVersionId}
            onChange={(event) => setStrategyVersionId(event.target.value)}
          >
            {strategyVersions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.strategyName} - {version.version}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="timeframe">Timeframe</label>
          <select
            id="timeframe"
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
          <label htmlFor="startDate">Start Date</label>
          <input
            id="startDate"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="endDate">End Date</label>
          <input
            id="endDate"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="initialBalance">Initial Balance</label>
          <input
            id="initialBalance"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={initialBalance}
            onChange={(event) => setInitialBalance(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="riskPercentage">Risk %</label>
          <input
            id="riskPercentage"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={riskPercentage}
            onChange={(event) => setRiskPercentage(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="slippageTicks">Slippage (ticks)</label>
          <input
            id="slippageTicks"
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={slippageTicks}
            onChange={(event) => setSlippageTicks(event.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="btn" disabled={!canSubmit}>
          {submitting ? "Starting backtest..." : "Run Backtest"}
        </button>
      </div>
    </form>
  );
}
