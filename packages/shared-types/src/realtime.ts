import { z } from "zod";
import { DIRECTIONS, SETUP_STATUSES } from "./enums";

/**
 * Cross-process realtime notification contract (Milestone 3). apps/worker
 * (where Setup creation/transitions actually happen) and apps/api (where
 * the WebSocket gateway lives) are separate deployables/processes, so they
 * cannot share an in-memory event emitter. apps/worker publishes JSON
 * messages matching RealtimeEvent to this Redis pub/sub channel; apps/api
 * subscribes and rebroadcasts to connected dashboard clients.
 *
 * WebSocket is a presentation transport only — PostgreSQL remains the
 * source of truth. A client that reconnects (or never received a message)
 * must reload current state from the REST API rather than depend on having
 * seen every message; see docs/tradingview-setup.md.
 */
export const REALTIME_CHANNEL = "trading-copilot:realtime";

const baseRealtimeEventFields = {
  timestamp: z.string().datetime(),
};

export const webhookReceivedEventSchema = z.object({
  type: z.literal("webhook.received"),
  ...baseRealtimeEventFields,
  webhookEventId: z.string().uuid(),
  provider: z.string(),
});

export const setupRealtimeEventSchema = z.object({
  type: z.enum([
    "setup.created",
    "setup.updated",
    "setup.expired",
    "setup.invalidated",
    "setup.rejected",
  ]),
  ...baseRealtimeEventFields,
  setupId: z.string().uuid(),
  instrumentId: z.string().uuid(),
  status: z.enum(SETUP_STATUSES),
  direction: z.enum(DIRECTIONS),
});

export const realtimeEventSchema = z.discriminatedUnion("type", [
  webhookReceivedEventSchema,
  z.object({ ...setupRealtimeEventSchema.shape, type: z.literal("setup.created") }),
  z.object({ ...setupRealtimeEventSchema.shape, type: z.literal("setup.updated") }),
  z.object({ ...setupRealtimeEventSchema.shape, type: z.literal("setup.expired") }),
  z.object({ ...setupRealtimeEventSchema.shape, type: z.literal("setup.invalidated") }),
  z.object({ ...setupRealtimeEventSchema.shape, type: z.literal("setup.rejected") }),
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type WebhookReceivedEvent = z.infer<typeof webhookReceivedEventSchema>;
export type SetupRealtimeEvent = z.infer<typeof setupRealtimeEventSchema>;

/** Parses and validates a raw Redis pub/sub message. Returns null (never throws) on anything malformed. */
export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  try {
    const result = realtimeEventSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
