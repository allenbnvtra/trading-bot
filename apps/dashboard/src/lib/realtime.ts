"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { RealtimeEvent } from "@/lib/api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * A single shared socket.io connection for the whole dashboard. Every page
 * or component that wants realtime updates calls `useRealtimeEvents` below,
 * which attaches/detaches its own listeners to this one socket rather than
 * opening a new connection per page - so navigating between pages never
 * multiplies connections.
 *
 * Lazily created (not at module load) so this file has no effect during
 * server rendering; the socket only ever exists in the browser.
 */
let sharedSocket: Socket | null = null;

function getSharedSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io(API_BASE_URL, {
      transports: ["websocket", "polling"],
      // socket.io-client's own reconnection stays on - see docs/architecture.md:
      // a client that reconnects reloads current state from the REST API rather
      // than trusting it saw every message while disconnected.
      reconnection: true,
    });
  }
  return sharedSocket;
}

export type ConnectionState = "connected" | "disconnected" | "reconnecting";

/**
 * Subscribes to the shared realtime socket for the lifetime of the calling
 * component. `onEvent` fires for every `realtime-event` message the server
 * rebroadcasts. `onReconnect` fires once whenever the socket establishes a
 * connection *after* having been connected before (i.e. a real reconnect,
 * not the initial connect) - callers use this as the trigger to refetch
 * their full list from the REST API, per docs/architecture.md's "reconnecting
 * client reloads from REST API" rule. Returns the current connection state
 * for rendering a small connected/disconnected/reconnecting indicator.
 */
export function useRealtimeEvents(
  onEvent: (event: RealtimeEvent) => void,
  onReconnect: () => void,
): ConnectionState {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    const socket = getSharedSocket();
    let hasConnectedOnce = socket.connected;
    setConnectionState(socket.connected ? "connected" : "disconnected");

    function handleConnect() {
      setConnectionState("connected");
      if (hasConnectedOnce) {
        onReconnectRef.current();
      }
      hasConnectedOnce = true;
    }

    function handleDisconnect() {
      setConnectionState("disconnected");
    }

    function handleReconnectAttempt() {
      setConnectionState("reconnecting");
    }

    function handleRealtimeEvent(event: RealtimeEvent) {
      onEventRef.current(event);
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.on("realtime-event", handleRealtimeEvent);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.off("realtime-event", handleRealtimeEvent);
    };
  }, []);

  return connectionState;
}
