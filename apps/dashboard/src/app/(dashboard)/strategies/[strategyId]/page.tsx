import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiError, getStrategy } from "@/lib/api";
import { formatDate } from "@/lib/format";

export default async function StrategyDetailPage({
  params,
}: {
  params: Promise<{ strategyId: string }>;
}) {
  const { strategyId } = await params;

  let strategy;
  try {
    strategy = await getStrategy(strategyId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load strategy.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Strategy</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{strategy.name}</h1>
        <p className="muted">
          <Link href="/strategies">&larr; all strategies</Link>
        </p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Key</div>
            <div className="detail-item__value">{strategy.key}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Created</div>
            <div className="detail-item__value">{formatDate(strategy.createdAt)}</div>
          </div>
        </div>
        {strategy.description && <p className="muted">{strategy.description}</p>}
      </div>

      <div className="card">
        <h2>Versions</h2>
        {strategy.versions.length === 0 && (
          <div className="empty-state">No versions recorded for this strategy.</div>
        )}
        {strategy.versions.map((version) => (
          <div className="card card--nested" key={version.id}>
            <div className="detail-grid">
              <div className="detail-item">
                <div className="detail-item__label">Version</div>
                <div className="detail-item__value">{version.version}</div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Name</div>
                <div className="detail-item__value">{version.name}</div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Status</div>
                <div className="detail-item__value">
                  <span className="badge badge--running">{version.status}</span>
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-item__label">Created</div>
                <div className="detail-item__value">{formatDate(version.createdAt)}</div>
              </div>
            </div>
            {version.description && <p className="muted">{version.description}</p>}
            <div className="detail-item__label" style={{ marginTop: 12 }}>
              Parameters
            </div>
            <pre className="params">{JSON.stringify(version.parameters, null, 2)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
