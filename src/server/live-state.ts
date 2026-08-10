import { isRunningFresh } from "../report/live.js";
import type { SlotView } from "../shared/payloads.js";
import { launchFailed, ownsRun } from "./launch/slot.js";
import type { LiveSnapshot } from "./reports-fs.js";

// What the dashboard believes is happening, decided from the launch slot, the
// newest live.json and the clock. Nothing here renders: the same answer drives
// a rendered panel, a websocket push and the decision to stop pushing at all.

export type LiveState =
  | { kind: "none" }
  | { kind: "starting" }
  | { kind: "failed" }
  | { kind: "running-fresh"; live: LiveSnapshot }
  | { kind: "running-paused"; live: LiveSnapshot }
  | { kind: "running-stale"; live: LiveSnapshot }
  | { kind: "done"; live: LiveSnapshot };

/**
 * The order is the point: a child this dashboard just started outranks whatever
 * the previous run left on disk, so a launch that is still packing never reads
 * as yesterday's finished matrix.
 *
 * `paused` is passed in rather than probed, so this stays a pure function of a
 * snapshot; the launcher owns the one place that asks the OS.
 */
export function liveState(
  slot: SlotView,
  live: LiveSnapshot | null,
  now: Date,
  paused = false,
): LiveState {
  const owns = ownsRun(slot, live);
  if (slot.alive && !owns) return { kind: "starting" };
  if (launchFailed(slot) && !owns) return { kind: "failed" };
  if (live === null) return { kind: "none" };
  if (live.doc.status === "running") {
    // Ahead of the freshness test, because a frozen run stops heartbeating: read
    // in the other order it would report as a crash, and send its reader hunting
    // for one that never happened.
    if (paused) return { kind: "running-paused", live };
    return isRunningFresh(live.doc, now) ? { kind: "running-fresh", live } : { kind: "running-stale", live };
  }
  return { kind: "done", live };
}

/** Only a state that expects to change again is worth watching; the rest are final. */
const EXPECTS_CHANGE: Record<LiveState["kind"], (slot: SlotView) => boolean> = {
  none: () => false,
  starting: () => true,
  failed: () => false,
  "running-fresh": () => true,
  // A frozen run changes nothing on disk and never will while it is held, but a
  // reader still has to be told the moment it is let go again.
  "running-paused": () => true,
  "running-stale": (slot) => slot.alive,
  done: () => false,
};

/**
 * Whether this state has anything left to say. A poller asks it to decide on the
 * next request; a channel asks it to decide whether to keep pushing. One rule,
 * so the two can never disagree about when a run is over.
 */
export function staysLive(state: LiveState, slot: SlotView): boolean {
  return EXPECTS_CHANGE[state.kind](slot);
}
