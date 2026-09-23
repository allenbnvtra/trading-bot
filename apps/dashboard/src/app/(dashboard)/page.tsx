import Link from "next/link";
import HealthIndicator from "@/components/HealthIndicator";

export default function DashboardHomePage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Trading Copilot</h1>
        <p>A personal trading research and decision-support platform.</p>
      </div>

      <div className="card">
        <h2>What this is</h2>
        <p>
          Trading Copilot is not an automatic trading bot. It never places broker orders.
          Humans execute every trade manually. This tool exists to produce trustworthy,
          deterministic, auditable research: historical candles, deterministic strategies,
          deterministic backtests, and dashboard inspection of the resulting trades and
          performance.
        </p>
        <p className="muted">
          See the <Link href="/research">Research</Link> page to run and inspect backtests.
        </p>
      </div>

      <HealthIndicator />

      <div className="card">
        <h2>Quick links</h2>
        <div className="quick-links">
          <Link href="/live-setups" className="quick-link">
            <div className="quick-link__title">Live Setups</div>
            <div className="quick-link__desc">Watch TradingView-sourced setups arrive in real time.</div>
          </Link>
          <Link href="/research" className="quick-link">
            <div className="quick-link__title">Research</div>
            <div className="quick-link__desc">Run a backtest and inspect its trades.</div>
          </Link>
          <Link href="/strategies" className="quick-link">
            <div className="quick-link__title">Strategies</div>
            <div className="quick-link__desc">Browse strategies and their versions.</div>
          </Link>
          <Link href="/backtests" className="quick-link">
            <div className="quick-link__title">Backtests</div>
            <div className="quick-link__desc">All backtests run so far.</div>
          </Link>
          <Link href="/market-data" className="quick-link">
            <div className="quick-link__title">Market Data</div>
            <div className="quick-link__desc">Instruments available for backtesting.</div>
          </Link>
        </div>
      </div>
    </div>
  );
}
