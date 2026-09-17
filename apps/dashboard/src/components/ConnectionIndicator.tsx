import type { ConnectionState } from "@/lib/realtime";

const CONNECTION_CLASS: Record<ConnectionState, string> = {
  connected: "badge--success",
  reconnecting: "badge--warning",
  disconnected: "badge--danger",
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: "Live",
  reconnecting: "Reconnecting...",
  disconnected: "Disconnected",
};

/**
 * A small, unobtrusive indicator of the shared realtime socket's connection
 * state, so a user is never left assuming they are watching live data when
 * they are not.
 */
export default function ConnectionIndicator({ state }: { state: ConnectionState }) {
  return <span className={`badge ${CONNECTION_CLASS[state]}`}>{CONNECTION_LABEL[state]}</span>;
}
