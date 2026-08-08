import type { Channel, ServerMessage } from "../shared/protocol.js";

// The registry between a socket and the things it watches. It knows nothing
// about reports, processes or files: a source pushes a payload at a channel and
// every subscriber to that channel receives it.
//
// Refcounting is the point. A source is started by its first subscriber and
// stopped by its last, so a dashboard nobody is looking at runs no `ps`, no `du`
// and no watcher at all.

export interface Client {
  id: string;
  send(message: ServerMessage): void;
}

export interface SourceHandle {
  stop(): void;
  /**
   * What a subscriber joining an already-running source needs to be current.
   * Sources only publish when something changed, so without this a second tab —
   * or a reload while another one is open — would sit blank until the next
   * change, which on a finished run never comes.
   */
  current(): unknown | null;
}

/** What a channel does while anyone is listening. */
export type Source = (publish: (payload: unknown) => void) => SourceHandle;

export interface Registry {
  add(client: Client): void;
  remove(client: Client): void;
  subscribe(client: Client, channel: Channel, params: unknown): void;
  unsubscribe(client: Client, channel: Channel): void;
  /** Pushes to every subscriber of one channel, whatever asked for it. */
  publish(channel: Channel, payload: unknown): void;
  /** Subscriber count, so a source can be told whether anyone is still there. */
  size(channel: Channel): number;
  /** Every param object currently subscribed to a channel, newest last. */
  paramsOf(channel: Channel): unknown[];
  stopAll(): void;
}

interface Subscription {
  client: Client;
  params: unknown;
}

interface Live {
  subs: Subscription[];
  /** null until the first subscriber starts the source. */
  handle: SourceHandle | null;
}

export function createRegistry(sources: Record<Channel, Source>): Registry {
  const live = new Map<Channel, Live>();

  function publish(channel: Channel, payload: unknown): void {
    const entry = live.get(channel);
    if (entry === undefined) return;
    for (const sub of entry.subs) sub.client.send({ type: "message", channel, payload });
  }

  function entryFor(channel: Channel): Live {
    const existing = live.get(channel);
    if (existing !== undefined) return existing;
    const entry: Live = { subs: [], handle: null };
    live.set(channel, entry);
    return entry;
  }

  /**
   * The first subscriber starts the source and is reached by whatever it publishes
   * on its first tick — which is why it is started only after the subscription is
   * already in the list. Every later subscriber gets the source's current state
   * addressed to it alone, since the others have already seen it.
   */
  function join(channel: Channel, entry: Live, client: Client): void {
    if (entry.handle === null) {
      entry.handle = sources[channel]((payload) => publish(channel, payload));
      return;
    }
    const current = entry.handle.current();
    if (current !== null) client.send({ type: "message", channel, payload: current });
  }

  function drop(channel: Channel, entry: Live): void {
    if (entry.subs.length > 0) return;
    entry.handle?.stop();
    live.delete(channel);
  }

  return {
    add: () => {},
    remove(client) {
      for (const [channel, entry] of [...live]) {
        entry.subs = entry.subs.filter((sub) => sub.client !== client);
        drop(channel, entry);
      }
    },
    subscribe(client, channel, params) {
      const entry = entryFor(channel);
      // One subscription per client per channel: a resubscribe replaces its
      // params rather than doubling the messages that client receives.
      entry.subs = entry.subs.filter((sub) => sub.client !== client);
      entry.subs.push({ client, params });
      join(channel, entry, client);
    },
    unsubscribe(client, channel) {
      const entry = live.get(channel);
      if (entry === undefined) return;
      entry.subs = entry.subs.filter((sub) => sub.client !== client);
      drop(channel, entry);
    },
    publish,
    size: (channel) => live.get(channel)?.subs.length ?? 0,
    paramsOf: (channel) => (live.get(channel)?.subs ?? []).map((sub) => sub.params),
    stopAll() {
      for (const [channel, entry] of [...live]) {
        entry.subs = [];
        drop(channel, entry);
      }
    },
  };
}
