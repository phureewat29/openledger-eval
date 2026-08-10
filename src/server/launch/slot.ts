import { isRunningFresh } from "../../report/live.js";
import type { PauseTarget, SlotView, StopTarget } from "../../shared/payloads.js";
import type { LiveSnapshot } from "../reports-fs.js";

// Every question asked of the launch slot — may a launch go ahead, what is the
// live region showing, is there anything to stop or hold — answered as a pure
// function of a plain snapshot of it. Only the spawn itself needs a real
// process, which is why none of this has one.

export const IDLE_SLOT: SlotView = {
  alive: false,
  launchedAt: null,
  stoppedAt: null,
  exit: null,
  pgid: null,
  tail: "",
};

/**
 * True when the newest live.json belongs to the run this slot started, rather
 * than to some earlier run.
 *
 * Compared against `openedAt` — when a runner took the iteration up — and not
 * `startedAt`, which a rerun inherits from the iteration it is merging into and
 * which therefore predates the launch that made it.
 */
export function ownsRun(slot: SlotView, live: LiveSnapshot | null): boolean {
  if (slot.launchedAt === null || live === null) return false;
  return Date.parse(live.doc.openedAt) >= Date.parse(slot.launchedAt);
}

/** A nonzero exit says the run ended badly; whether it ever started is `ownsRun`'s question. */
export function launchFailed(slot: SlotView): boolean {
  return slot.exit !== null && slot.exit.code !== 0;
}

/**
 * Whether a run this dashboard did not spawn is still there to be signalled.
 *
 * A frozen run stops writing its heartbeat, so freshness alone would read it as
 * dead — and a dead run is neither stoppable nor resumable, which would strand
 * exactly the run a pause created. Being stopped therefore counts as being
 * alive: the process is there, and it is there because someone asked for it.
 */
function isReachable(live: LiveSnapshot, now: Date, paused: boolean): boolean {
  if (live.doc.status !== "running") return false;
  return paused || isRunningFresh(live.doc, now);
}

/**
 * The run worth asking the OS about, or null when there is nothing there.
 *
 * The existence check is what makes this cheap enough to ask every second.
 * `status: "running"` alone is not evidence a run is alive — a matrix killed
 * outright leaves that word on disk for ever, and probing it would fork a `ps`
 * a second, indefinitely, on a dashboard nobody is looking at.
 *
 * Existence rather than freshness, because a paused run is deliberately not
 * fresh: its heartbeat stops the moment it is frozen, so a freshness gate would
 * hide the very state the probe exists to find. `exists` is a signal-0 syscall,
 * next to nothing beside the fork it saves.
 */
export function runPid(
  slot: SlotView,
  live: LiveSnapshot | null,
  exists: (pid: number) => boolean,
): number | null {
  if (slot.alive) return slot.pgid;
  if (live === null || live.doc.status !== "running") return null;
  const pid = live.doc.pid;
  return pid !== undefined && exists(pid) ? pid : null;
}

/** null when a launch may go ahead; otherwise the reason to show, since these POSTs spend money. */
export function busyReason(
  slot: SlotView,
  live: LiveSnapshot | null,
  now: Date,
  paused = false,
): string | null {
  if (slot.alive) return "this dashboard already has a run in flight";
  if (live === null || !isReachable(live, now, paused)) return null;
  // A frozen run holds its sandboxes and its place; starting a second one beside
  // it would spend against a machine already carrying the first.
  return paused ? `${live.slug} is paused` : `${live.slug} is still running`;
}

const NOTHING_TO_STOP: StopTarget = { kind: "none" };

/**
 * Decided from the run rather than from who spawned it, so restarting the
 * dashboard does not make a live matrix unstoppable and a run started at a
 * terminal is no different from one started here.
 *
 * Signalling a pid read out of a file is safe because of two guards together.
 * The process must still exist, so a finished run is never signalled; and the
 * run must be beating — `isRunningFresh`, the one authority on that — which is
 * what makes a recycled pid a non-issue. Whatever the OS handed that id to next
 * is not writing this live.json, so the run reads as stale and is never offered
 * as a target at all.
 */
export function stopTarget(
  slot: SlotView,
  live: LiveSnapshot | null,
  now: Date,
  exists: (pid: number) => boolean,
  paused = false,
): StopTarget {
  // A slot holding a child answers for it alone: once that child has been
  // signalled there is nothing further to send, whatever its live.json says.
  if (slot.alive) return slot.stoppedAt === null ? { kind: "owned" } : NOTHING_TO_STOP;

  if (live === null || !isReachable(live, now, paused)) return NOTHING_TO_STOP;
  const { pid } = live.doc;
  if (pid === undefined || !exists(pid)) return NOTHING_TO_STOP;
  return { kind: "foreign", pid };
}

const NOTHING_TO_HOLD: PauseTarget = { kind: "none" };

/**
 * Derived from what a stop would reach, so pause can never address a run stop
 * cannot — including a child already sent its SIGINT, which is on its way out
 * and must not be frozen on the way.
 *
 * `opened` is whether the run has written its live.json yet. A child still
 * packing has not, and freezing one leaves nothing on disk naming its pid: this
 * dashboard could let it go again from its own slot, but a restarted one would
 * find a frozen process it has no way to name, and the run would have to be
 * continued from a terminal. Nothing is in flight during that window anyway, so
 * there is nothing there worth holding.
 */
export function pauseTarget(
  stop: StopTarget,
  slot: SlotView,
  paused: boolean,
  opened: boolean,
): PauseTarget {
  if (stop.kind === "none" || !opened) return NOTHING_TO_HOLD;

  const pid = stop.kind === "foreign" ? stop.pid : slot.pgid;
  if (pid === null) return NOTHING_TO_HOLD;
  return { kind: paused ? "resume" : "pause", owned: stop.kind === "owned", pid };
}
