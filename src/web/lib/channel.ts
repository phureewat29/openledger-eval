import { useEffect, useRef, useState } from "react";
import type { Channel, ServerMessage } from "../../shared/protocol.js";

// One socket for the whole page, shared by every channel any component asks for.
// The server pushes only when something changed, so a message arriving is always
// news and a component can render straight from the last one it saw.

export type ConnectionStatus = "connecting" | "open" | "closed";

type Listener = (payload: unknown) => void;

const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000];

interface Subscription {
  channel: Channel;
  params: unknown;
  listener: Listener;
}

interface ChannelClient {
  subscribe(channel: Channel, params: unknown, listener: Listener): () => void;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  /** Changes when the dashboard process restarts, which invalidates anything cached. */
  onServer(listener: (serverId: string) => void): () => void;
}

function socketUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function createClient(): ChannelClient {
  const subs = new Set<Subscription>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const serverListeners = new Set<(serverId: string) => void>();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let closed = false;

  const setStatus = (status: ConnectionStatus): void => {
    for (const listener of statusListeners) listener(status);
  };

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  function connect(): void {
    if (closed) return;
    setStatus("connecting");
    const next = new WebSocket(socketUrl());
    socket = next;

    next.addEventListener("open", () => {
      attempt = 0;
      setStatus("open");
      // Everything the page was watching is re-asked for: the server keeps no
      // memory of a socket that dropped.
      for (const sub of subs) send({ cmd: "subscribe", channel: sub.channel, params: sub.params });
    });

    next.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "welcome") {
        for (const listener of serverListeners) listener(message.serverId);
        return;
      }
      if (message.type !== "message") return;
      for (const sub of subs) {
        if (sub.channel === message.channel) sub.listener(message.payload);
      }
    });

    const retry = (): void => {
      if (closed || socket !== next) return;
      socket = null;
      setStatus("closed");
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 5_000;
      attempt += 1;
      setTimeout(connect, wait);
    };

    next.addEventListener("close", retry);
    next.addEventListener("error", () => next.close());
  }

  connect();

  return {
    subscribe(channel, params, listener) {
      const sub: Subscription = { channel, params, listener };
      subs.add(sub);
      send({ cmd: "subscribe", channel, params });
      return () => {
        subs.delete(sub);
        // Only the last reader of a channel tells the server to stop.
        if (![...subs].some((other) => other.channel === channel)) send({ cmd: "unsubscribe", channel });
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
    onServer(listener) {
      serverListeners.add(listener);
      return () => void serverListeners.delete(listener);
    },
  };
}

let shared: ChannelClient | null = null;

function client(): ChannelClient {
  shared ??= createClient();
  return shared;
}

/** The last payload a channel pushed, or null until the first one arrives. */
export function useChannel<T>(channel: Channel, params: unknown = {}): T | null {
  const [data, setData] = useState<T | null>(null);
  // Params are compared by value: an inline object literal must not resubscribe
  // on every render.
  const key = JSON.stringify(params);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    return client().subscribe(channel, JSON.parse(key) as unknown, (payload) => setData(payload as T));
  }, [channel, key]);

  return data;
}

export function useConnection(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  useEffect(() => client().onStatus(setStatus), []);
  return status;
}

/** Reloads when the dashboard restarts under a page that outlived it. */
export function useServerIdentity(): void {
  useEffect(() => {
    let first: string | null = null;
    return client().onServer((serverId) => {
      first ??= serverId;
      if (first !== serverId) location.reload();
    });
  }, []);
}
