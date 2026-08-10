import * as z from "zod";

// The wire between the dashboard and its page. ActionCable's shape, trimmed to
// what one local reader needs: name a channel, get pushed to until the thing it
// watches has nothing left to say.
//
// A subscription carries no arguments. Every source follows the newest
// iteration, so there is nothing to ask it for — the slug and byte-offset
// parameters this once declared were validated on arrival and then read by
// nobody at either end.
//
// This file is imported by both programs, so it holds no node:* import and
// nothing but types and schemas.

export const CHANNELS = ["live", "feed", "processes", "sandboxes"] as const;

export type Channel = (typeof CHANNELS)[number];

export const CLIENT_MESSAGE = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("subscribe"), channel: z.enum(CHANNELS) }),
  z.object({ cmd: z.literal("unsubscribe"), channel: z.enum(CHANNELS) }),
]);

export type ClientMessage = z.infer<typeof CLIENT_MESSAGE>;

/**
 * A page that reconnects to a different `serverId` is talking to a dashboard
 * that restarted, so whatever it cached about the run is no longer trustworthy
 * and it refetches rather than patching.
 */
export interface WelcomeMessage {
  type: "welcome";
  serverId: string;
}

export interface DataMessage {
  type: "message";
  channel: Channel;
  payload: unknown;
}

export interface ErrorMessage {
  type: "error";
  channel: Channel | null;
  error: string;
}

export type ServerMessage = WelcomeMessage | DataMessage | ErrorMessage;

// The payload field is left as z.unknown(): each channel's own payload type is
// declared in shared/payloads.ts and checked downstream, not re-validated here.
export const SERVER_MESSAGE = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), serverId: z.string() }),
  z.object({ type: z.literal("message"), channel: z.enum(CHANNELS), payload: z.unknown() }),
  z.object({ type: z.literal("error"), channel: z.enum(CHANNELS).nullable(), error: z.string() }),
]);

export function parseClientMessage(text: string): ClientMessage | null {
  const json = ((): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  const parsed = CLIENT_MESSAGE.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** null on anything unparseable or mismatching, which a caller treats as an expected, droppable frame. */
export function parseServerMessage(text: string): ServerMessage | null {
  const json = ((): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  const parsed = SERVER_MESSAGE.safeParse(json);
  return parsed.success ? parsed.data : null;
}
