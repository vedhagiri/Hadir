// Hooks backing the Live Capture page (P28.5).
//
// * ``useLiveStats`` polls ``GET /api/cameras/{id}/live-stats`` every
//   10 seconds. Paused when no camera is selected so the page idles
//   cheaply on first load.
// * ``useEventStream`` opens a WebSocket to ``/api/cameras/{id}/events.ws``
//   and exposes a rolling buffer of the last 50 detection events.
//   Auto-reconnects with exponential backoff on disconnect (max 30 s).
//   Closes cleanly on unmount or camera switch.

import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api/client";
import type { LiveEvent, LiveStats, WsMessage } from "./types";

const ROLLING_BUFFER_SIZE = 50;

export function useLiveStats(
  cameraId: number | null,
): UseQueryResult<LiveStats, Error> {
  return useQuery({
    queryKey: ["live-stats", cameraId],
    queryFn: () => api<LiveStats>(`/api/cameras/${cameraId}/live-stats`),
    enabled: cameraId != null,
    refetchInterval: cameraId != null ? 10_000 : false,
    staleTime: 5_000,
  });
}

export type EventStreamStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface EventStreamHandle {
  events: LiveEvent[];
  status: EventStreamStatus;
  /** Server's most recent heartbeat (ISO string), or null. */
  lastHeartbeat: string | null;
  /** Force a reconnect — used by the page's "Reconnect" button. */
  reconnect: () => void;
}

/**
 * Manage a WebSocket subscription for the given camera. Returns a
 * stable handle whose ``events`` array updates as detections arrive.
 *
 * Reconnect strategy: 1 s → 2 s → 4 s → ... capped at 30 s. The
 * counter resets on every successful open, so a flaky link doesn't
 * accumulate backoff across the session.
 */
export function useEventStream(cameraId: number | null): EventStreamHandle {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>("idle");
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1_000);
  const reconnectTimerRef = useRef<number | null>(null);
  const closedByCallerRef = useRef(false);

  const reconnect = useCallback(() => {
    closedByCallerRef.current = false;
    backoffRef.current = 1_000;
    setReconnectNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (cameraId == null) {
      setStatus("idle");
      setEvents([]);
      return;
    }
    closedByCallerRef.current = false;
    setStatus("connecting");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/cameras/${cameraId}/events.ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      backoffRef.current = 1_000;
      setStatus("open");
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(e.data) as WsMessage;
      } catch {
        return;
      }
      if (msg.type === "heartbeat") {
        setLastHeartbeat(msg.server_time);
        return;
      }
      if (msg.type === "detection") {
        setEvents((cur) => {
          const next = [msg, ...cur];
          return next.length > ROLLING_BUFFER_SIZE
            ? next.slice(0, ROLLING_BUFFER_SIZE)
            : next;
        });
      }
      // ``stats`` messages currently don't drive UI state — the
      // 10 s ``useLiveStats`` poll covers the same surface.
    };

    ws.onerror = () => {
      // Surface as reconnecting; ``onclose`` fires immediately
      // after and schedules the actual retry.
      setStatus("reconnecting");
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (closedByCallerRef.current) {
        setStatus("closed");
        return;
      }
      setStatus("reconnecting");
      const delay = Math.min(backoffRef.current, 30_000);
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      reconnectTimerRef.current = window.setTimeout(() => {
        setReconnectNonce((n) => n + 1);
      }, delay);
    };

    return () => {
      closedByCallerRef.current = true;
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
    // ``reconnectNonce`` re-runs the effect on Reconnect / on
    // backoff timer fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, reconnectNonce]);

  // Reset the rolling buffer when the camera changes.
  useEffect(() => {
    setEvents([]);
    setLastHeartbeat(null);
  }, [cameraId]);

  return { events, status, lastHeartbeat, reconnect };
}
