import type { Result } from "../../core/result.js";
import type { PauseAction, PauseTarget, SlotExit, SlotView, StopTarget } from "../../shared/payloads.js";
import type { LiveSnapshot } from "../reports-fs.js";
import { rerunArgs, spawnArgs, type LaunchRequest, type RerunRequest } from "./request.js";
import { busyReason, IDLE_SLOT, launchFailed, ownsRun, pauseTarget, runPid, stopTarget } from "./slot.js";

// The dashboard's only mutable state: one slot holding the eval process this
// dashboard started. Spawning and signalling arrive as injected functions, so
// the whole state machine can be driven without an OS underneath it.

const TAIL_LINES = 30;

const KILL_GRACE_MS = 10_000;

/**
 * The little of a child process the slot uses; the adapter beside this hides
 * node's two ways of ending one. `kill` reaches the whole process group rather
 * than the one child, which is the only version of stopping that is true: `npm`
 * forwards what it chooses to, and an `oled` call already in flight is a
 * grandchild it holds no handle on.
 */
export interface ChildHandle {
  /** The spawned child, which leads its own group, so this is the pgid too. */
  pid: number;
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface LauncherDeps {
  start(args: string[]): Result<ChildHandle>;
  tail(lines: number): string;
  /** Does a process by that id exist? Injected, so no test ever probes a real one. */
  exists(pid: number): boolean;
  /** The interrupt a run this dashboard did not spawn gets; injected for the same reason. */
  interrupt(pid: number): Result<void>;
  /** SIGSTOP or SIGCONT for such a run, which has its own rule about half-reached groups. */
  hold(pid: number, signal: NodeJS.Signals): Result<void>;
  /** Is that run frozen right now? Read from the OS, never remembered; injected so no test runs a ps. */
  stopped(pid: number): boolean;
}

export type LaunchOutcome = { ok: true } | { ok: false; reason: "busy" | "spawn"; message: string };

export type StopOutcome = { ok: true } | { ok: false; reason: "idle" | "signal"; message: string };

const IDLE_STOP: StopOutcome = { ok: false, reason: "idle", message: "nothing to stop: no run is in flight" };

/** Everything that differs between the two directions of a hold, and nothing else does. */
const HOLD: Record<PauseAction, { signal: NodeJS.Signals; idle: StopOutcome; already: string }> = {
  pause: {
    signal: "SIGSTOP",
    idle: { ok: false, reason: "idle", message: "nothing to pause: no run is in flight" },
    already: "already paused",
  },
  resume: {
    signal: "SIGCONT",
    idle: { ok: false, reason: "idle", message: "nothing to resume: no run is paused" },
    already: "not paused",
  },
};

/** Every signal this could not send reads the same way: what was asked, of which pid, and why not. */
function signalOutcome(verb: string, pid: number, sent: Result<void>): StopOutcome {
  if (sent.ok) return { ok: true };
  return { ok: false, reason: "signal", message: `cannot ${verb} pid ${pid}: ${sent.error}` };
}

export interface Launcher {
  launch(request: LaunchRequest, live: LiveSnapshot | null, now: Date): LaunchOutcome;
  /** A rerun is a launch with a narrower argv; the busy guard and the slot are the same. */
  rerun(request: RerunRequest, live: LiveSnapshot | null, now: Date): LaunchOutcome;
  /**
   * What a stop would reach right now; the page renders its button from this and
   * nothing else. `paused` is passed in rather than probed, so a caller building
   * a whole payload asks the OS once instead of once per question it happens to
   * ask — the same shape `liveState` already takes.
   */
  target(live: LiveSnapshot | null, now: Date, paused: boolean): StopTarget;
  /** The same, for the hold buttons; `kind` is the verb on offer. */
  holdTarget(live: LiveSnapshot | null, now: Date, paused: boolean): PauseTarget;
  stop(live: LiveSnapshot | null, now: Date): StopOutcome;
  hold(action: PauseAction, live: LiveSnapshot | null, now: Date): StopOutcome;
  /** Whether the reachable run is frozen; the busy guard and every state read need it. */
  frozen(live: LiveSnapshot | null): boolean;
  view(): SlotView;
}

interface Slot {
  child: ChildHandle;
  launchedAt: string;
  alive: boolean;
  stoppedAt: string | null;
  exit: SlotExit | null;
  escalation: NodeJS.Timeout | null;
}

export function createLauncher(deps: LauncherDeps): Launcher {
  let slot: Slot | null = null;

  function view(): SlotView {
    if (slot === null) return IDLE_SLOT;
    const snapshot: SlotView = {
      alive: slot.alive,
      launchedAt: slot.launchedAt,
      stoppedAt: slot.stoppedAt,
      exit: slot.exit,
      pgid: slot.child.pid,
      tail: "",
    };
    return launchFailed(snapshot) ? { ...snapshot, tail: deps.tail(TAIL_LINES) } : snapshot;
  }

  /** Takes the slot it was registered for, never `slot`, so an old child cannot retire a newer one. */
  function retire(claimed: Slot, code: number | null): void {
    if (!claimed.alive) return;
    claimed.alive = false;
    claimed.exit = { code, at: new Date().toISOString() };
    if (claimed.escalation !== null) clearTimeout(claimed.escalation);
  }

  /**
   * The one place that asks the OS whether a run is frozen, and the only fork in
   * the whole read. Callers that ask several questions of one moment — the live
   * payload asks three — call this once and pass the answer down.
   */
  function frozen(live: LiveSnapshot | null): boolean {
    const pid = runPid(view(), live, deps.exists);
    return pid !== null && deps.stopped(pid);
  }

  function spawnRun(args: string[], live: LiveSnapshot | null, now: Date): LaunchOutcome {
    // Refusal and claim happen in the same tick. Node runs one handler at a
    // time, so no second POST can slip in between and spawn a rival run.
    const busy = busyReason(view(), live, now, frozen(live));
    if (busy !== null) return { ok: false, reason: "busy", message: busy };

    const started = deps.start(args);
    if (!started.ok) return { ok: false, reason: "spawn", message: started.error };

    const claimed: Slot = {
      child: started.value,
      launchedAt: now.toISOString(),
      alive: true,
      stoppedAt: null,
      exit: null,
      escalation: null,
    };
    slot = claimed;
    started.value.onExit((code) => retire(claimed, code));
    return { ok: true };
  }

  function target(live: LiveSnapshot | null, now: Date, paused: boolean): StopTarget {
    return stopTarget(view(), live, now, deps.exists, paused);
  }

  function holdTarget(live: LiveSnapshot | null, now: Date, paused: boolean): PauseTarget {
    // A foreign run was found by its own live.json, so it has opened one by
    // definition; an owned child has only once that document is its.
    const opened = !view().alive || ownsRun(view(), live);
    return pauseTarget(target(live, now, paused), view(), paused, opened);
  }

  function stop(live: LiveSnapshot | null, now: Date): StopOutcome {
    const claimed = slot;
    // A stopped process queues a SIGINT rather than acting on it, so a frozen run
    // would be killed by the escalation with its sandboxes still on disk. The
    // continue comes first, and the interrupt lands on something able to run its
    // cleanup handler.
    const held = frozen(live);
    const reached = target(live, now, held);

    if (reached.kind === "foreign") {
      // A continue that failed leaves the run frozen, so the interrupt behind it
      // would only be queued: that is a stop that did not happen rather than a
      // run that stopped, and it is reported as one.
      if (held) {
        const continued = signalOutcome("continue", reached.pid, deps.hold(reached.pid, "SIGCONT"));
        if (!continued.ok) return continued;
      }
      // One SIGINT and no more: there is no handle to watch, so nothing to
      // escalate to and nothing to record.
      return signalOutcome("interrupt", reached.pid, deps.interrupt(reached.pid));
    }
    // An owned target is resolved from the slot itself, so a null one here is
    // the type's case rather than a state this can be in.
    if (reached.kind === "none" || claimed === null) return IDLE_STOP;

    claimed.stoppedAt = now.toISOString();
    if (held) claimed.child.kill("SIGCONT");
    claimed.child.kill("SIGINT");
    // SIGINT is what the workspace guard cleans up on; SIGKILL is only for a
    // child that never reaches it. Aimed at this child, so an escalation left
    // over from an earlier stop can never reach a later run.
    claimed.escalation = setTimeout(() => claimed.child.kill("SIGKILL"), KILL_GRACE_MS);
    claimed.escalation.unref();
    return { ok: true };
  }

  function hold(action: PauseAction, live: LiveSnapshot | null, now: Date): StopOutcome {
    const claimed = slot;
    const reached = holdTarget(live, now, frozen(live));
    if (reached.kind === "none") return HOLD[action].idle;
    // Asking to pause an already-frozen run, or to resume one that is running,
    // is a page acting on a state it has since left rather than a failure.
    if (reached.kind !== action) {
      return { ok: false, reason: "idle", message: `that run is ${HOLD[action].already}` };
    }

    if (!reached.owned) return signalOutcome(action, reached.pid, deps.hold(reached.pid, HOLD[action].signal));
    // The slot's own handle, so ok means a signal that was really sent; a null
    // slot is the type's case, as it is in stop, and holds nothing to send one to.
    if (claimed === null) return HOLD[action].idle;
    claimed.child.kill(HOLD[action].signal);
    return { ok: true };
  }

  return {
    launch: (request, live, now) => spawnRun(spawnArgs(request), live, now),
    rerun: (request, live, now) => spawnRun(rerunArgs(request), live, now),
    target,
    holdTarget,
    stop,
    hold,
    frozen,
    view,
  };
}
