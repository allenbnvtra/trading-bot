"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, closeJournalTrade } from "@/lib/api";

/** Formats "now" for a `<input type="datetime-local">` default value, in the browser's local timezone. */
function nowAsLocalDateTimeInputValue(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The CLOSE TRADE action on an OPEN journal trade's detail page. Calls
 * POST /journal/trades/:id/close with exactly closeJournalTradeSchema's
 * fields - no `mfe`/`mae` inputs (those are computed server-side from real
 * candle data) and no client-side P&L/R/outcome computation of any kind.
 * The response's own grossPnl/netPnl/rMultiple/outcome/mfe/mae are rendered
 * by the parent page after a router.refresh(), never derived here.
 */
export default function CloseTradeCard({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actualExit, setActualExit] = useState("");
  const [exitTimestamp, setExitTimestamp] = useState(nowAsLocalDateTimeInputValue);
  const [actualFees, setActualFees] = useState("");
  const [actualSlippage, setActualSlippage] = useState("");
  const [exitNotes, setExitNotes] = useState("");

  function openForm() {
    setError(null);
    setOpen(true);
  }

  function closeForm() {
    setOpen(false);
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await closeJournalTrade(tradeId, {
        actualExit,
        exitTimestamp: new Date(exitTimestamp).toISOString(),
        actualFees: actualFees === "" ? undefined : actualFees,
        actualSlippage: actualSlippage === "" ? undefined : actualSlippage,
        exitNotes: exitNotes.trim() === "" ? undefined : exitNotes.trim(),
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This trade has already been closed.");
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to close trade.");
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Close Trade</h2>

      {!open && (
        <div className="form-actions">
          <button type="button" className="btn" onClick={openForm}>
            CLOSE TRADE
          </button>
        </div>
      )}

      {open && (
        <form onSubmit={handleSubmit}>
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="actualExit">Actual Exit</label>
              <input
                id="actualExit"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={actualExit}
                onChange={(event) => setActualExit(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="exitTimestamp">Exit Time</label>
              <input
                id="exitTimestamp"
                type="datetime-local"
                value={exitTimestamp}
                onChange={(event) => setExitTimestamp(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="actualFees">Fees (optional)</label>
              <input
                id="actualFees"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={actualFees}
                onChange={(event) => setActualFees(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="actualSlippage">Slippage (optional)</label>
              <input
                id="actualSlippage"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={actualSlippage}
                onChange={(event) => setActualSlippage(event.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="exitNotes">Exit Notes (optional)</label>
            <input
              id="exitNotes"
              type="text"
              maxLength={2000}
              value={exitNotes}
              onChange={(event) => setExitNotes(event.target.value)}
            />
          </div>

          <div className="form-actions">
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? "Closing..." : "Confirm Close"}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={closeForm}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
