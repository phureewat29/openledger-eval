import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVAL_ROOT } from "../../config.js";
import { tryExecute, type Result } from "../../core/result.js";
import { LAUNCH_LOG } from "../../shared/paths.js";
import {
  groupOf,
  inGroup,
  isSafeGroup,
  listProcessesSync,
  processExists,
  processStopped,
  selfProc,
  signalGroup,
} from "../procs.js";
import { createLauncher, type ChildHandle } from "./launcher.js";

// The one part of a launch that touches the OS: spawning the run into a log,
// reading that log back, and signalling a run this dashboard did not start. The
// wired launcher at the foot of the file is what the server holds.

const LAUNCH_LOG_PATH = join(EVAL_ROOT, LAUNCH_LOG);

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
 * The group a foreign pid leads, with the verdict on whether signalling all of
 * it would take only the run with it. `verb` is the caller's word for what it is
 * about to do, so a run that has already gone says so in the caller's terms.
 */
function resolveGroup(pid: number, verb: string): Result<{ pgid: number; safe: Result<void> }> {
  const procs = listProcessesSync();
  if (!procs.ok) return procs;

  const pgid = groupOf(procs.value, pid);
  if (pgid === null) return { ok: false, error: `no process ${pid} to ${verb}` };

  const safe = isSafeGroup(pgid, inGroup(procs.value, pgid), selfProc(procs.value));
  return { ok: true, value: { pgid, safe } };
}

/** A group signal reported the way this file reports every other: what was asked, and why not. */
function signalWhole(pgid: number, signal: NodeJS.Signals, verb: string): Result<void> {
  const signalled = signalGroup(pgid, signal);
  if (!signalled.ok) return { ok: false, error: `cannot ${verb} group ${pgid}: ${signalled.error}` };
  return { ok: true, value: undefined };
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
  const group = resolveGroup(pid, "interrupt");
  if (!group.ok) return group;

  const { pgid, safe } = group.value;
  if (!safe.ok) return tryExecute(() => void process.kill(pid, "SIGINT"));
  return signalWhole(pgid, "SIGINT", "interrupt");
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
  const group = resolveGroup(pid, "signal");
  if (!group.ok) return group;

  const { pgid, safe } = group.value;
  if (!safe.ok && signal === "SIGSTOP") {
    return { ok: false, error: `will not pause a half-reachable run: ${safe.error}` };
  }
  if (!safe.ok) return tryExecute(() => void process.kill(pid, signal));
  return signalWhole(pgid, signal, "signal");
}

export const launcher = createLauncher({
  start: startEval,
  tail: (lines) => tailFile(LAUNCH_LOG_PATH, lines),
  exists: processExists,
  interrupt: interruptForeign,
  hold: holdForeign,
  stopped: processStopped,
});
