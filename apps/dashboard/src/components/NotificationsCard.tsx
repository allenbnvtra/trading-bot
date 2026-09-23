import type { NotificationDelivery, NotificationType } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { NotificationDeliveryStatusBadge } from "./StatusBadge";

const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  SETUP_PREPARE: "Setup Prepare",
  SETUP_READY: "Setup Ready",
  SETUP_INVALIDATED: "Setup Invalidated",
  SETUP_EXPIRED: "Setup Expired",
  SETUP_REJECTED: "Setup Rejected",
};

/**
 * Pure presentational, same shape as ScreenshotCard - renders whatever
 * notification delivery rows it is given. No retry action here (unlike
 * ScreenshotCard's FAILED retry button): a stuck/FAILED notification is
 * retried by the worker's own BullMQ backoff, not by a dashboard action
 * (Task 12 brief only asks for a read-only status block).
 */
export default function NotificationsCard({
  notifications,
}: {
  notifications: NotificationDelivery[];
}) {
  if (notifications.length === 0) {
    return <div className="empty-state">No notifications sent for this setup yet.</div>;
  }

  return (
    <div className="screenshot-list">
      {notifications.map((notification) => (
        <div key={notification.id} className="card card--nested">
          <div className="detail-grid">
            <div className="detail-item">
              <div className="detail-item__label">Type</div>
              <div className="detail-item__value">
                {NOTIFICATION_TYPE_LABELS[notification.notificationType]}
              </div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Provider</div>
              <div className="detail-item__value">{notification.provider}</div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Status</div>
              <div className="detail-item__value">
                <NotificationDeliveryStatusBadge status={notification.status} />
              </div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Attempts</div>
              <div className="detail-item__value">{notification.attemptCount}</div>
            </div>
            <div className="detail-item">
              <div className="detail-item__label">Sent</div>
              <div className="detail-item__value">{formatDateTime(notification.sentAt)}</div>
            </div>
          </div>

          {notification.status === "FAILED" && (
            <div className="error-banner">
              {notification.failureCode ? `${notification.failureCode}: ` : ""}
              {notification.failureMessage ?? "Notification delivery failed; no further detail was recorded."}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
