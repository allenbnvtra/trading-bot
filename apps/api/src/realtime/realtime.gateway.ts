import { Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import Redis from "ioredis";
import type { Server } from "socket.io";
import { REALTIME_CHANNEL, parseRealtimeEvent } from "@trading-copilot/shared-types";
import { createRedisConnectionOptions } from "../common/redis-connection";
import { parseRealtimeCorsOrigin } from "./realtime-cors";

const corsOrigin = parseRealtimeCorsOrigin(process.env.REALTIME_CORS_ORIGIN);

/**
 * Rebroadcasts apps/worker's Redis pub/sub notifications (Setup
 * creation/transitions, webhook receipt) to connected dashboard clients.
 * This gateway never originates state - it only forwards what it reads
 * from REALTIME_CHANNEL, unchanged. No filtering/auth: single-user local
 * tool (see docs/tradingview-setup.md "Realtime").
 *
 * WebSocket CORS origin is configurable via REALTIME_CORS_ORIGIN env var
 * (unset/empty = permissive for local development; set to a comma-separated
 * list of exact origins in production).
 *
 * Pub/sub requires its own dedicated Redis connection (a subscribed
 * connection cannot issue other commands), so this uses a separate ioredis
 * client rather than reusing BullMQ's connection.
 */
@WebSocketGateway({ cors: { origin: corsOrigin } })
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly subscriber = new Redis(createRedisConnectionOptions());

  async onModuleInit(): Promise<void> {
    await this.subscriber.subscribe(REALTIME_CHANNEL);
    this.subscriber.on("message", (channel: string, message: string) => {
      if (channel !== REALTIME_CHANNEL) {
        return;
      }

      const event = parseRealtimeEvent(message);
      if (!event) {
        // A reconnecting/never-connected client always reloads current
        // state from the REST API (docs/architecture.md), so dropping an
        // unparseable message here is never a correctness problem - it
        // would only ever mean a slightly stale realtime UI update.
        this.logger.warn("Dropped an unparseable realtime pub/sub message");
        return;
      }

      this.server.emit("realtime-event", event);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber.disconnect();
  }
}
