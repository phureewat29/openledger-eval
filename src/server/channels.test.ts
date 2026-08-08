import assert from "node:assert/strict";
import { test } from "node:test";
import type { Channel } from "../shared/protocol.js";
import { createRegistry, type Client, type Source } from "./channels.js";

/** Records what a client was sent, so a fan-out can be counted rather than described. */
function fakeClient(id: string): Client & { received: unknown[] } {
  const received: unknown[] = [];
  return {
    id,
    received,
    send: (message) => void received.push(message),
  };
}

/** A source that publishes once on start, so "was anyone listening yet" is observable. */
function greeting(text: string): Source {
  return (publish) => {
    publish(text);
    return { stop: () => {}, current: () => text };
  };
}

function sources(overrides: Partial<Record<Channel, Source>> = {}): Record<Channel, Source> {
  const idle: Source = () => ({ stop: () => {}, current: () => null });
  return { live: idle, feed: idle, processes: idle, sandboxes: idle, ...overrides };
}

test("a subscriber receives what its source publishes the instant it starts", () => {
  // The source is started only once the subscription is in the list; starting it
  // any earlier sends that first payload to nobody, which is how a live panel
  // ends up blank until something happens to change.
  const registry = createRegistry(sources({ live: greeting("hello") }));
  const client = fakeClient("a");

  registry.subscribe(client, "live", {});
  assert.deepEqual(client.received, [{ type: "message", channel: "live", payload: "hello" }]);
});

test("a second subscriber does not restart a source that is already running", () => {
  let starts = 0;
  const registry = createRegistry(
    sources({
      live: (publish) => {
        starts += 1;
        publish(starts);
        return { stop: () => {}, current: () => starts };
      },
    }),
  );

  registry.subscribe(fakeClient("a"), "live", {});
  registry.subscribe(fakeClient("b"), "live", {});
  assert.equal(starts, 1);
});

test("a subscriber joining a running source is caught up rather than left blank", () => {
  // A source only speaks when something changed, so without a catch-up the
  // second reader of a finished run would wait forever for a change that will
  // never come — which is what a reload with another tab open looks like.
  const registry = createRegistry(sources({ live: greeting("hello") }));
  registry.subscribe(fakeClient("first"), "live", {});

  const late = fakeClient("late");
  registry.subscribe(late, "live", {});
  assert.deepEqual(late.received, [{ type: "message", channel: "live", payload: "hello" }]);
});

test("the catch-up goes only to the subscriber that asked for it", () => {
  const registry = createRegistry(sources({ live: greeting("hello") }));
  const first = fakeClient("first");
  registry.subscribe(first, "live", {});
  assert.equal(first.received.length, 1);

  registry.subscribe(fakeClient("late"), "live", {});
  assert.equal(first.received.length, 1, "a reader already current is told nothing again");
});

test("a source with nothing to say yet catches nobody up", () => {
  const registry = createRegistry(sources());
  registry.subscribe(fakeClient("first"), "live", {});

  const late = fakeClient("late");
  registry.subscribe(late, "live", {});
  assert.deepEqual(late.received, []);
});

test("a publish reaches every subscriber of that channel and nobody else", () => {
  let push = (_payload: unknown): void => {};
  const registry = createRegistry(
    sources({
      live: (publish) => {
        push = publish;
        return { stop: () => {}, current: () => null };
      },
    }),
  );

  const [a, b, c] = [fakeClient("a"), fakeClient("b"), fakeClient("c")];
  registry.subscribe(a, "live", {});
  registry.subscribe(b, "live", {});
  registry.subscribe(c, "feed", {});

  push("news");
  assert.equal(a.received.length, 1);
  assert.equal(b.received.length, 1);
  assert.equal(c.received.length, 0);
});

test("the source stops when its last subscriber leaves, and not before", () => {
  let stopped = 0;
  const registry = createRegistry(sources({ live: () => ({ stop: () => void (stopped += 1), current: () => null }) }));
  const [a, b] = [fakeClient("a"), fakeClient("b")];

  registry.subscribe(a, "live", {});
  registry.subscribe(b, "live", {});
  registry.unsubscribe(a, "live");
  assert.equal(stopped, 0, "one reader left is still a reader");

  registry.unsubscribe(b, "live");
  assert.equal(stopped, 1);
});

test("a disconnect takes every channel that client was watching with it", () => {
  const stops: Channel[] = [];
  const registry = createRegistry(
    sources({
      live: () => ({ stop: () => void stops.push("live"), current: () => null }),
      feed: () => ({ stop: () => void stops.push("feed"), current: () => null }),
    }),
  );
  const client = fakeClient("a");

  registry.subscribe(client, "live", {});
  registry.subscribe(client, "feed", {});
  registry.remove(client);
  assert.deepEqual(stops.toSorted(), ["feed", "live"]);
});

test("subscribing twice replaces the params rather than doubling the messages", () => {
  let push = (_payload: unknown): void => {};
  const registry = createRegistry(
    sources({
      feed: (publish) => {
        push = publish;
        return { stop: () => {}, current: () => null };
      },
    }),
  );
  const client = fakeClient("a");

  registry.subscribe(client, "feed", { slug: "2026-08-08-0230" });
  registry.subscribe(client, "feed", { slug: "2026-08-08-0245" });
  assert.equal(registry.size("feed"), 1);
  assert.deepEqual(registry.paramsOf("feed"), [{ slug: "2026-08-08-0245" }]);

  push("one");
  assert.equal(client.received.length, 1);
});

test("publishing to a channel nobody watches reaches nobody and throws nothing", () => {
  const registry = createRegistry(sources());
  registry.publish("live", "into the void");
  assert.equal(registry.size("live"), 0);
});

test("stopping the registry stops every running source", () => {
  let stopped = 0;
  const registry = createRegistry(sources({ live: () => ({ stop: () => void (stopped += 1), current: () => null }) }));
  registry.subscribe(fakeClient("a"), "live", {});

  registry.stopAll();
  assert.equal(stopped, 1);
  assert.equal(registry.size("live"), 0);
});
