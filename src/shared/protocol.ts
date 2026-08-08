import * as z from "zod";
import { ITERATION_SLUG_RE } from "./vocabulary.js";

// The wire between the dashboard and its page. ActionCable's shape, trimmed to
// what one local reader needs: name a channel, get pushed to until the thing it
// watches has nothing left to say.
//
// This file is imported by both programs, so it holds no node:* import and
// nothing but types and schemas.

export const PROTOCOL_VERSION = 1;

export const CHANNELS = ["live", "feed", "processes", "sandboxes"] as const;

export type Channel = (typeof CHANNELS)[number];

const SLUG = z.string().regex(ITERATION_SLUG_RE);

/** Omitted means "whichever iteration is newest", which is what a live view follows. */
const LIVE_PARAMS = z.object({ slug: SLUG.optional() });

const FEED_PARAMS = z.object({
  slug: SLUG.optional(),
  /** Byte offset already seen; the server sends only what comes after it. */
  after: z.number().int().nonnegative().optional(),
});

const NO_PARAMS = z.object({});

/**
 * One entry per channel, so a channel added to the list above fails to compile
 * until it declares what subscribing to it takes.
 */
export const CHANNEL_PARAMS: { [K in Channel]: z.ZodType } = {
  live: LIVE_PARAMS,
  feed: FEED_PARAMS,
  processes: NO_PARAMS,
  sandboxes: NO_PARAMS,
};

export type LiveParams = z.infer<typeof LIVE_PARAMS>;
export type FeedParams = z.infer<typeof FEED_PARAMS>;

/**
 * Two stages, not one union: a discriminated union on `cmd` cannot also
 * discriminate on `channel` without an intersection that loses the outer tag.
 * The envelope is parsed here, the params against the table above.
 */
export const CLIENT_MESSAGE = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("subscribe"), channel: z.enum(CHANNELS), params: z.unknown() }),
  z.object({ cmd: z.literal("unsubscribe"), channel: z.enum(CHANNELS) }),
  z.object({ cmd: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof CLIENT_MESSAGE>;

/**
 * A page that reconnects to a different `serverId` is talking to a dashboard
 * that restarted, so whatever it cached about the run is no longer trustworthy
 * and it refetches rather than patching.
 */
export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
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

export interface PongMessage {
  type: "pong";
}

export type ServerMessage = WelcomeMessage | DataMessage | ErrorMessage | PongMessage;

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

/** The params a subscribe carried, or the reason they were refused. */
export function parseChannelParams(
  channel: Channel,
  params: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = CHANNEL_PARAMS[channel].safeParse(params ?? {});
  if (!parsed.success) return { ok: false, error: `bad params for ${channel}: ${z.prettifyError(parsed.error)}` };
  return { ok: true, value: parsed.data };
}
