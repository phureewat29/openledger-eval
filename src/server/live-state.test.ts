import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveDoc } from "../report/live.js";
import type { RunIdentity } from "../report/record.js";
import { IDLE_SLOT } from "./launch.js";
import { liveState, staysLive } from "./live-state.js";
import type { LiveSnapshot } from "./reports-fs.js";

const NOW = new Date("2026-08-07T05:00:00.000Z");

const IDENTITY: RunIdentity = {
  startedAt: "2026-08-07T04:44:10.327Z",
  oledVersion: "0.20.1",
  tarballSha256: "94270f6a3338",
  skillVersion: "0.20.1",
  skillSha256: "2120973bc677",
  evalVersion: "1.0.0",
};

function beat(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1_000).toISOString();
}

function snapshot(status: LiveDoc["status"], updatedAt: string): LiveSnapshot {
  return {
    slug: "2026-08-07-1144",
    doc: {
      schemaVersion: 1,
      status,
      startedAt: IDENTITY.startedAt,
      openedAt: IDENTITY.startedAt,
      updatedAt,
      pid: 4242,
      identity: IDENTITY,
      config: { suites: ["query"], trials: 1, concurrency: 1, modelsRequested: ["a/model"] },
      items: [],
    },
  };
}

// Freezing a run stops its heartbeat, so reading staleness ahead of paused would
// mistake a held run for a crashed one and send its reader hunting for a crash
// that never happened.
test("a paused run reads as running-paused even once its heartbeat has gone stale", () => {
  const stale = snapshot("running", beat(40));
  assert.deepEqual(liveState(IDLE_SLOT, stale, NOW, true), { kind: "running-paused", live: stale });
});

test("the same stale heartbeat reads as running-stale once paused is false", () => {
  const stale = snapshot("running", beat(40));
  assert.deepEqual(liveState(IDLE_SLOT, stale, NOW, false), { kind: "running-stale", live: stale });
});

test("staysLive keeps watching a paused run, since it still has something left to say once let go", () => {
  const held = { kind: "running-paused" as const, live: snapshot("running", beat(40)) };
  assert.equal(staysLive(held, IDLE_SLOT), true);
});
