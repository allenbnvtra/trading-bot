/**
 * Milestone 1 ships with exactly one synthetic dataset and one deliberately
 * untuned strategy — see docs/backtesting-assumptions.md and
 * docs/research-methodology.md. That scoping lives in the docs, but a
 * dashboard user (including the platform's own author, months later) has no
 * reason to go read those files before trusting a number on this page. This
 * banner keeps that context visible wherever backtest results are shown,
 * rather than relying on someone remembering to check the docs.
 */
export default function ResearchDisclaimer() {
  return (
    <p className="note-banner">
      This reflects one deterministic strategy version run against the instrument/date range shown, on
      synthetic development data unless real candles have been imported. The default strategy parameters
      are intentionally untuned (infrastructure validation, not a trading recommendation). See{" "}
      <code>docs/backtesting-assumptions.md</code> and <code>docs/research-methodology.md</code> before
      drawing conclusions from these numbers.
    </p>
  );
}
