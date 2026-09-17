import Redis from "ioredis";
import { REALTIME_CHANNEL, type RealtimeEvent } from "@trading-copilot/shared-types";
import { createRedisConnectionOptions } from "./redis-connection";

/**
 * Thin wrapper around a plain ioredis PUBLISH. apps/worker is where Setup
 * creation and status transitions actually happen (tradingview-webhook and
 * setup-expiration processors); apps/api's WebSocket gateway subscribes to
 * the same REALTIME_CHANNEL and rebroadcasts to dashboard clients
 * unchanged. See docs/architecture.md "Source of truth" - PostgreSQL
 * remains authoritative regardless of whether a given pub/sub message is
 * ever delivered, so a publish failure here is logged, never thrown.
 */
let client: Redis | null = null;

function getClient(): Redis {
  if (!client) {
    client = new Redis(createRedisConnectionOptions());
  }
  return client;
}

export async function publishRealtimeEvent(event: RealtimeEvent): Promise<void> {
  try {
    await getClient().publish(REALTIME_CHANNEL, JSON.stringify(event));
  } catch (error) {
    // Realtime notification is a presentation nicety, never the source of
    // truth - a failed publish must never fail the job that already
    // succeeded at the actual database write (Setup created/transitioned).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to publish realtime event "${event.type}": ${message}`);
  }
}
