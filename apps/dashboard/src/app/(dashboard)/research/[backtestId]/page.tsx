import { notFound } from "next/navigation";
import { ApiError, getBacktest } from "@/lib/api";
import BacktestDetailClient from "./BacktestDetailClient";

export default async function BacktestDetailPage({
  params,
}: {
  params: Promise<{ backtestId: string }>;
}) {
  const { backtestId } = await params;

  let backtest;
  try {
    backtest = await getBacktest(backtestId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load backtest.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Backtest</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  return <BacktestDetailClient backtestId={backtestId} initialBacktest={backtest} />;
}
