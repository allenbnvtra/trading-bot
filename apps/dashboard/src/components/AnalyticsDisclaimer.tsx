/**
 * /analytics blends two structurally different trade populations under one
 * strategy-version row: Milestone 1's simulated BacktestTrade fills and
 * Milestone 2's real/paper JournalTrade closes (see
 * docs/trade-journal-design.md "Backtest -> journal compatibility"). The
 * per-trade Source column makes that blend discoverable on drill-down, but
 * nothing at the summary level said so — a viewer could otherwise mistake a
 * single "Trades" count for a more validated sample than it is. Sample
 * sizes here are also typically far below the guardrails
 * docs/research-methodology.md sets for even a paper-trading decision. This
 * banner keeps both caveats visible without a click, mirroring
 * ResearchDisclaimer's role on /research.
 */
export default function AnalyticsDisclaimer() {
  return (
    <p className="note-banner">
      Trade counts here can combine simulated backtest fills and real/paper journal trades under one
      strategy-version row — check the Source column on the trades table before treating a number as
      evidence about live performance. Current sample sizes are typically far below the guardrails in{" "}
      <code>docs/research-methodology.md</code> for even a paper-trading decision.
    </p>
  );
}
