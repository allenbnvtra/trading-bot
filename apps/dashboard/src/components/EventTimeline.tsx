import type { JournalEvent } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { EVENT_TYPE_LABELS } from "@/components/StatusBadge";

/**
 * Renders a setup's lifecycle as a vertical timeline. Only events actually
 * present in `events` are rendered, in the order the API returned them
 * (already chronological) - there is never a placeholder row for a step
 * that hasn't happened yet.
 */
export default function EventTimeline({ events }: { events: JournalEvent[] }) {
  if (events.length === 0) {
    return <div className="empty-state">No timeline events recorded for this setup.</div>;
  }

  return (
    <ul className="timeline">
      {events.map((event) => (
        <li className="timeline-item" key={event.id}>
          <div className="timeline-item__header">
            <span className="timeline-item__label">{EVENT_TYPE_LABELS[event.eventType]}</span>
            <span className="timeline-item__timestamp">{formatDateTime(event.timestamp)}</span>
          </div>
          <div className="timeline-item__meta">
            {event.entityType} &middot; {event.entityId}
          </div>
        </li>
      ))}
    </ul>
  );
}
