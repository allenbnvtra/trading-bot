import { redirect } from "next/navigation";

/**
 * The Backtests nav item and the Research page show the same list of
 * backtests (Research additionally offers the create-backtest form above
 * it). Rather than duplicate the list rendering/data-fetching, this route
 * redirects into /research, which is the canonical place to browse and
 * create backtests for Milestone 1.
 */
export default function BacktestsPage() {
  redirect("/research");
}
