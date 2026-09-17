import { ApiError, getHealth, type TradingViewIngestionHealth } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

function Dot({ up }: { up: boolean }) {
  return (
    <span
      className={`badge badge--dot ${up ? "badge--completed" : "badge--failed"}`}
      style={{ marginRight: 8 }}
    >
      {up ? "up" : "down"}
    </span>
  );
}

const INGESTION_BADGE_CLASS: Record<TradingViewIngestionHealth["status"], string> = {
  ONLINE: "badge--completed",
  DEGRADED: "badge--failed",
  UNKNOWN: "badge--neutral",
};

export default async function HealthIndicator() {
  try {
    const health = await getHealth();
    return (
      <div className="card">
        <h2>System Health</h2>
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Overall</div>
            <div className="detail-item__value">
              <span
                className={`badge ${health.status === "ok" ? "badge--completed" : "badge--failed"}`}
              >
                {health.status}
              </span>
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Postgres</div>
            <div className="detail-item__value">
              <Dot up={health.postgres === "up"} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Redis</div>
            <div className="detail-item__value">
              <Dot up={health.redis === "up"} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">TradingView Ingestion</div>
            <div className="detail-item__value">
              <span className={`badge ${INGESTION_BADGE_CLASS[health.tradingViewIngestion.status]}`}>
                {health.tradingViewIngestion.status}
              </span>
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Last Webhook Received</div>
            <div className="detail-item__value">
              {formatDateTime(health.tradingViewIngestion.lastEventAt)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Last Successful Processing</div>
            <div className="detail-item__value">
              {formatDateTime(health.tradingViewIngestion.lastSuccessfulProcessingAt)}
            </div>
          </div>
        </div>
      </div>
    );
  } catch (err) {
    const message =
      err instanceof ApiError ? err.message : "Could not check API health.";
    return (
      <div className="card">
        <h2>System Health</h2>
        <div className="error-banner">{message}</div>
      </div>
    );
  }
}
