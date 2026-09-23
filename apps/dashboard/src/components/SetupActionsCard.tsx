"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, executeSetup, skipSetup, SKIP_REASONS, type SkipReason } from "@/lib/api";

type ActiveForm = "PAPER" | "MANUAL_LIVE" | "SKIP" | null;

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  MISSED_ALERT: "Missed the alert",
  PRICE_MOVED: "Price moved before I could act",
  MANUAL_DISAGREEMENT: "Disagreed with the setup",
  RISK_TOO_HIGH: "Risk too high",
  BUSY: "Was busy / unavailable",
  SETUP_NO_LONGER_VALID: "Setup no longer valid",
  OTHER: "Other",
};

/** Formats "now" for a `<input type="datetime-local">` default value, in the browser's local timezone. */
function nowAsLocalDateTimeInputValue(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The three action buttons on a READY Setup's detail page: PAPER TRADE and
 * I ENTERED THIS TRADE both call POST /setups/:id/execute (only
 * executionMode differs), SKIP TRADE calls POST /setups/:id/skip. Neither
 * endpoint's response is ever recomputed here - the returned JournalTrade
 * is only used for its id, to navigate to its own detail page where the
 * API's own numbers are rendered.
 *
 * A 409 from /execute (the setup already has an OPEN JournalTrade - see
 * setup.service.ts#execute's double-submit guard) is translated to a
 * specific, human message rather than shown as the raw backend text.
 */
export default function SetupActionsCard({ setupId }: { setupId: string }) {
  const router = useRouter();
  const [activeForm, setActiveForm] = useState<ActiveForm>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actualEntry, setActualEntry] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [entryTimestamp, setEntryTimestamp] = useState(nowAsLocalDateTimeInputValue);
  const [actualFees, setActualFees] = useState("");
  const [actualSlippage, setActualSlippage] = useState("");
  const [notes, setNotes] = useState("");

  const [skipReason, setSkipReason] = useState<SkipReason | "">("");

  function openForm(form: Exclude<ActiveForm, null>) {
    setError(null);
    setActiveForm(form);
  }

  function closeForm() {
    setActiveForm(null);
    setError(null);
  }

  async function handleExecuteSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (activeForm !== "PAPER" && activeForm !== "MANUAL_LIVE") return;
    setSubmitting(true);
    setError(null);
    try {
      const trade = await executeSetup(setupId, {
        executionMode: activeForm,
        actualEntry,
        quantity: Number(quantity),
        entryTimestamp: new Date(entryTimestamp).toISOString(),
        actualFees: actualFees === "" ? undefined : actualFees,
        actualSlippage: actualSlippage === "" ? undefined : actualSlippage,
        notes: notes.trim() === "" ? undefined : notes.trim(),
      });
      router.push(`/trades/${trade.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This setup has already been executed.");
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to record trade execution.");
      }
      setSubmitting(false);
    }
  }

  async function handleSkipSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const trade = await skipSetup(setupId, skipReason === "" ? undefined : skipReason);
      router.push(`/trades/${trade.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This setup already has a recorded trade decision.");
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to record skip.");
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Trade Actions</h2>

      {activeForm === null && (
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => openForm("PAPER")}>
            PAPER TRADE
          </button>
          <button type="button" className="btn" onClick={() => openForm("MANUAL_LIVE")}>
            I ENTERED THIS TRADE
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => openForm("SKIP")}>
            SKIP TRADE
          </button>
        </div>
      )}

      {(activeForm === "PAPER" || activeForm === "MANUAL_LIVE") && (
        <form onSubmit={handleExecuteSubmit}>
          {error && <div className="error-banner">{error}</div>}
          <p className="muted">
            {activeForm === "PAPER"
              ? "Record this as a paper (simulated) execution."
              : "Record this as a manually executed live trade."}
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="actualEntry">Actual Entry</label>
              <input
                id="actualEntry"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={actualEntry}
                onChange={(event) => setActualEntry(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="quantity">Quantity</label>
              <input
                id="quantity"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="entryTimestamp">Entry Time</label>
              <input
                id="entryTimestamp"
                type="datetime-local"
                value={entryTimestamp}
                onChange={(event) => setEntryTimestamp(event.target.value)}
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
            <label htmlFor="notes">Notes (optional)</label>
            <input
              id="notes"
              type="text"
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          <div className="form-actions">
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? "Recording..." : "Confirm"}
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

      {activeForm === "SKIP" && (
        <form onSubmit={handleSkipSubmit}>
          {error && <div className="error-banner">{error}</div>}
          <div className="field">
            <label htmlFor="skipReason">Reason (optional)</label>
            <select
              id="skipReason"
              value={skipReason}
              onChange={(event) => setSkipReason(event.target.value as SkipReason | "")}
            >
              <option value="">No reason given</option>
              {SKIP_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {SKIP_REASON_LABELS[reason]}
                </option>
              ))}
            </select>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? "Recording..." : "Confirm Skip"}
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
