import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniq } from "es-toolkit";
import { EVAL_ROOT, SUITE_IDS, type SuiteId } from "../config.js";
import { tryExecute, type Result } from "../core/result.js";
import { isRunningFresh } from "../report/live.js";
import {
  groupOf,
  inGroup,
  isSafeGroup,
  listProcessesSync,
  processExists,
  processStopped,
  selfProc,
  signalGroup,
} from "./procs.js";
import { LAUNCH_LOG } from "../shared/paths.js";
import type { LiveSnapshot } from "./reports-fs.js";

// The dashboard's only mutable state: one slot holding the eval process this
// dashboard started. Every decision taken from that state — may a launch go
// ahead, what is the live region showing, is there anything to stop — is a pure
// function of a plain snapshot, so only the spawn itself needs a real process.

/** Suites are ticked, like models: "all" is what picking every one means, not another thing to pick. */
export const SUITE_SELECTIONS: SuiteId[] = [...SUITE_IDS];

export { LAUNCH_LOG };

const LAUNCH_LOG_PATH = join(EVAL_ROOT, LAUNCH_LOG);

const TAIL_LINES = 30;

const KILL_GRACE_MS = 10_000;

export interface LaunchRequest {
  suites: SuiteId[];
  models: string[];
}

function isSuiteId(value: string): value is SuiteId {
  return (SUITE_SELECTIONS as string[]).includes(value);
}

/**
 * The whitelist between an HTML form and a process argv: a suite that is not
 * ours and a model id that is not already in models.json never reach spawn, so
 * no submitted string can become a command-line argument on its own.
 */
export function parseLaunchRequest(form: URLSearchParams, modelIds: string[]): Result<LaunchRequest> {
  const suites = uniq(form.getAll("suite"));
  if (suites.length === 0) return { ok: false, error: "pick at least one suite" };

  const strange = suites.filter((suite) => !isSuiteId(suite));
  if (strange.length > 0) {
    return { ok: false, error: `not a suite: ${strange.join(", ")}` };
  }

  const models = uniq(form.getAll("model"));
  if (models.length === 0) return { ok: false, error: "pick at least one model" };

  const unknown = models.filter((model) => !modelIds.includes(model));
  if (unknown.length > 0) return { ok: false, error: `not a model in models.json: ${unknown.join(", ")}` };

  return { ok: true, value: { suites: suites.filter(isSuiteId), models } };
}

/** --suite repeats, one per ticked box, except that every box ticked is the flag the CLI spells "all". */
function suiteFlags(suites: SuiteId[]): string[] {
  if (suites.length === SUITE_SELECTIONS.length) return ["--suite", "all"];
  return suites.flatMap((suite) => ["--suite", suite]);
}

/** The argv a terminal run would use, so a dashboard launch and `npm run eval` cannot drift apart. */
export function spawnArgs(request: LaunchRequest): string[] {
  return [
    "run",
    "eval",
    "--",
    ...suiteFlags(request.suites),
    ...request.models.flatMap((model) => ["--model", model]),
  ];
}

/**
 * One model's cases of one suite, run again into the report they came from.
 * An empty `cases` is the whole suite for that model — the grid's row — and one
 * entry is a single cell; the two scopes the dashboard offers are the same
 * request, so nothing downstream has to tell them apart.
 */
export interface RerunRequest {
  slug: string;
  model: string;
  suite: SuiteId;
  cases: string[];
}

/** What a case id may look like before it is allowed to become an argument. */
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/i;

/** The same whitelist parseLaunchRequest applies, for the one route that names a case. */
export function parseRerunRequest(
  slug: string,
  body: { model: string; suite: string; cases?: string[] },
  modelIds: string[],
): Result<RerunRequest> {
  if (!isSuiteId(body.suite)) return { ok: false, error: `not a suite: ${body.suite}` };
  if (!modelIds.includes(body.model)) {
    return { ok: false, error: `not a model in models.json: ${body.model}` };
  }

  const cases = uniq(body.cases ?? []);
  const strange = cases.filter((id) => !CASE_ID.test(id));
  if (strange.length > 0) return { ok: false, error: `not a case id: ${strange.join(", ")}` };

  return { ok: true, value: { slug, model: body.model, suite: body.suite, cases } };
}

export function rerunArgs(request: RerunRequest): string[] {
  return [
    "run",
    "eval",
    "--",
    "--into",
    request.slug,
    "--suite",
    request.suite,
    "--model",
    request.model,
    ...request.cases.flatMap((id) => ["--case", id]),
  ];
}

export interface SlotExit {
  code: number | null;
  at: string;
}

/** A snapshot of the slot as plain data; views and decisions never reach into the slot itself. */
export interface SlotView {
  alive: boolean;
  launchedAt: string | null;
  stoppedAt: string | null;
  exit: SlotExit | null;
  /** The group every process of this run belongs to; null when the slot holds nothing. */
  pgid: number | null;
  /** Last lines of the launch log, read only for a child that died badly; empty otherwise. */
  tail: string;
}

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
  const opened = live.doc.openedAt ?? live.doc.startedAt;
  return Date.parse(opened) >= Date.parse(slot.launchedAt);
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

/** What a stop would reach: the child in the slot, a run known only by its report, or nothing at all. */
export type StopTarget = { kind: "owned" } | { kind: "foreign"; pid: number } | { kind: "none" };

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

/** Which way a run can be held right now: the two are never both on offer. */
export type PauseAction = "pause" | "resume";

export type PauseTarget = { kind: "none" } | { kind: PauseAction; owned: boolean; pid: number };

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

/**
 * The little of a child process the slot uses; the adapter below hides node's
 * two ways of ending one. `kill` reaches the whole process group rather than the
 * one child, which is the only version of stopping that is true: `npm` forwards
 * what it chooses to, and an `oled` call already in flight is a grandchild it
 * holds no handle on.
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

const IDLE_HOLD: Record<PauseAction, StopOutcome> = {
  pause: { ok: false, reason: "idle", message: "nothing to pause: no run is in flight" },
  resume: { ok: false, reason: "idle", message: "nothing to resume: no run is paused" },
};

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

  /** One SIGINT and no more: there is no handle to watch, so nothing to escalate to and nothing to record. */
  function interrupt(pid: number): StopOutcome {
    const signalled = deps.interrupt(pid);
    if (signalled.ok) return { ok: true };
    return { ok: false, reason: "signal", message: `cannot interrupt pid ${pid}: ${signalled.error}` };
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
      if (held) deps.hold(reached.pid, "SIGCONT");
      return interrupt(reached.pid);
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

  const HOLD_SIGNAL: Record<PauseAction, NodeJS.Signals> = { pause: "SIGSTOP", resume: "SIGCONT" };

  function hold(action: PauseAction, live: LiveSnapshot | null, now: Date): StopOutcome {
    const reached = holdTarget(live, now, frozen(live));
    if (reached.kind === "none") return IDLE_HOLD[action];
    // Asking to pause an already-frozen run, or to resume one that is running,
    // is a page acting on a state it has since left rather than a failure.
    if (reached.kind !== action) {
      const already = action === "pause" ? "already paused" : "not paused";
      return { ok: false, reason: "idle", message: `that run is ${already}` };
    }

    const signal = HOLD_SIGNAL[action];
    const signalled = reached.owned
      ? tryExecute(() => slot?.child.kill(signal))
      : deps.hold(reached.pid, signal);
    if (signalled.ok) return { ok: true };
    return { ok: false, reason: "signal", message: `cannot ${action} pid ${reached.pid}: ${signalled.error}` };
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

/**
 * Node announces a child that never started with `error` and one that ended with
 * `exit`; the slot only needs "it is over".
 *
 * `kill` signals the negated pid, which POSIX reads as the process group. The
 * child was spawned detached so it leads a group of its own, and every process
 * the run goes on to make inherits it — the runner under `tsx`, an `npm install`
 * per sandbox, and up to eight concurrent `oled` calls. Signalling the child
 * alone left those running and their sandboxes on disk.
 */
function adopt(child: ChildProcess): ChildHandle {
  // A child that failed to spawn has no pid; the group kill below is skipped for
  // it, and the error path retires the slot without ever reaching a signal.
  const pid = child.pid ?? 0;
  return {
    pid,
    kill(signal) {
      if (pid === 0) return;
      // The group can empty between the decision to stop and the signal, which
      // is not a failure: it is the outcome the caller asked for.
      tryExecute(() => process.kill(-pid, signal));
    },
    onExit(listener) {
      child.once("exit", (code) => listener(code));
      child.once("error", () => listener(null));
    },
  };
}

/**
 * Output goes to a log file descriptor rather than pipes: the child keeps a
 * valid descriptor if this dashboard exits, and everything a run prints before
 * live.json exists — usage, pack and bootstrap failures — stays readable.
 *
 * `detached` puts the run in a session of its own. That is what makes a stop
 * reach the whole tree, and it keeps the existing promise that a run outlives
 * the dashboard that started it.
 */
function startEval(args: string[]): Result<ChildHandle> {
  const opened = tryExecute(() => {
    mkdirSync(dirname(LAUNCH_LOG_PATH), { recursive: true });
    return openSync(LAUNCH_LOG_PATH, "w");
  });
  if (!opened.ok) return { ok: false, error: `cannot open ${LAUNCH_LOG}: ${opened.error}` };

  const fd = opened.value;
  try {
    const child = tryExecute(() =>
      spawn("npm", args, { cwd: EVAL_ROOT, stdio: ["ignore", fd, fd], detached: true }),
    );
    if (!child.ok) return { ok: false, error: `cannot start npm: ${child.error}` };
    return { ok: true, value: adopt(child.value) };
  } finally {
    // The child holds its own copy of the descriptor from here on.
    closeSync(fd);
  }
}

function tailFile(path: string, lines: number): string {
  const text = tryExecute(() => readFileSync(path, "utf8"));
  if (!text.ok) return "";
  return text.value.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * A run this dashboard did not start still gets its whole group signalled where
 * that is provably safe — otherwise the `oled` calls in flight outlive the stop
 * exactly as they did for an owned run.
 *
 * Where it is not provably safe the single pid is signalled instead, which is
 * what this did before groups existed: less thorough, never wrong. Either way it
 * is one signal and no escalation, because a run this dashboard did not start is
 * not its to keep score of — the run going quiet is the confirmation.
 */
function interruptForeign(pid: number): Result<void> {
  const procs = listProcessesSync();
  if (!procs.ok) return procs;

  const pgid = groupOf(procs.value, pid);
  if (pgid === null) return { ok: false, error: `no process ${pid} to interrupt` };

  const safe = isSafeGroup(pgid, inGroup(procs.value, pgid), selfProc(procs.value));
  if (!safe.ok) return tryExecute(() => void process.kill(pid, "SIGINT"));

  const signalled = signalGroup(pgid, "SIGINT");
  if (!signalled.ok) return { ok: false, error: `cannot interrupt group ${pgid}: ${signalled.error}` };
  return { ok: true, value: undefined };
}

/**
 * Freezing or continuing a run this dashboard did not start, and the one place
 * the two directions are treated differently.
 *
 * A group that cannot be signalled whole is refused a SIGSTOP: half a run frozen
 * is worse than none, because the half still awake goes on spending while the
 * dashboard says the run is held. A SIGCONT falls back to the single pid
 * instead, since continuing part of a run can only improve on leaving all of it
 * frozen — and this is the path that unfreezes a run before stopping it.
 */
function holdForeign(pid: number, signal: NodeJS.Signals): Result<void> {
  const procs = listProcessesSync();
  if (!procs.ok) return procs;

  const pgid = groupOf(procs.value, pid);
  if (pgid === null) return { ok: false, error: `no process ${pid} to signal` };

  const safe = isSafeGroup(pgid, inGroup(procs.value, pgid), selfProc(procs.value));
  if (!safe.ok) {
    if (signal === "SIGSTOP") return { ok: false, error: `will not pause a half-reachable run: ${safe.error}` };
    return tryExecute(() => void process.kill(pid, signal));
  }

  const signalled = signalGroup(pgid, signal);
  if (!signalled.ok) return { ok: false, error: `cannot signal group ${pgid}: ${signalled.error}` };
  return { ok: true, value: undefined };
}

export const launcher = createLauncher({
  start: startEval,
  tail: (lines) => tailFile(LAUNCH_LOG_PATH, lines),
  exists: processExists,
  interrupt: interruptForeign,
  hold: holdForeign,
  stopped: processStopped,
});
