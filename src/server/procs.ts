import { execFileSync } from "node:child_process";
import { tryExecute, type Result } from "../core/result.js";
import { execCapture } from "../oled/command.js";

// Everything a run is actually made of. A matrix is `npm` over `tsx` over the
// runner, which in turn spawns `npm install` per sandbox and one `oled` per tool
// call — so the pid the dashboard holds names the smallest part of the tree.
// Reading the whole group is what makes a stop honest and an orphan visible.

/** ps is asked for a fixed column set in a fixed order, so the parser never guesses. */
const PS_ARGV = ["-Ao", "pid,ppid,pgid,stat,%cpu,rss,etime,command"];

const PS_TIMEOUT_MS = 5_000;

/** Seven columns then the command, which is the only field allowed to hold spaces. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/;

/** `rss` is kibibytes on darwin and linux alike; the wire carries bytes so no reader has to know that. */
const RSS_UNIT = 1_024;

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** The `stat` column verbatim — `S`, `Ss`, `R+`, `T`, `Z` — read by isStopped and shown as-is. */
  state: string;
  /** Percent of one core, as ps reports it. */
  cpu: number;
  rssBytes: number;
  elapsedSec: number;
  command: string;
}

export interface ProcNode extends ProcInfo {
  children: ProcNode[];
}

/**
 * ps writes elapsed time in four widths — `SS`, `MM:SS`, `HH:MM:SS` and
 * `DD-HH:MM:SS` — and the wider ones only appear once a run has been going long
 * enough that nobody is watching for the moment they arrive.
 */
export function parseElapsed(etime: string): number {
  const [left, right] = etime.includes("-") ? etime.split("-") : [null, etime];
  const days = left === null ? 0 : Number(left);
  const parts = (right ?? "").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return days * 86_400 + seconds;
}

/** A line ps wrote in a shape this does not know is dropped; its neighbours are still read. */
export function parsePs(stdout: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const [, pid, ppid, pgid, state, cpu, rss, etime, command] = match;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      state: state ?? "",
      cpu: Number(cpu),
      rssBytes: Number(rss) * RSS_UNIT,
      elapsedSec: parseElapsed(etime ?? ""),
      command: command ?? "",
    });
  }
  return rows;
}

export async function listProcesses(): Promise<Result<ProcInfo[]>> {
  const result = await execCapture("ps", PS_ARGV, { timeoutMs: PS_TIMEOUT_MS });
  if (!result.ok) return { ok: false, error: `ps did not run: ${result.message}` };
  if (result.value.exitCode !== 0) {
    return { ok: false, error: `ps exited ${result.value.exitCode}: ${result.value.stderr.trim()}` };
  }
  return { ok: true, value: parsePs(result.value.stdout) };
}

/**
 * The group a pid belongs to. This is the whole of adopting a run started at a
 * terminal: live.json records one pid, and its own pgid column names every
 * process that run is responsible for.
 */
export function groupOf(procs: ProcInfo[], pid: number): number | null {
  return procs.find((proc) => proc.pid === pid)?.pgid ?? null;
}

export function inGroup(procs: ProcInfo[], pgid: number): ProcInfo[] {
  return procs.filter((proc) => proc.pgid === pgid);
}

/**
 * Parents before children, and anything whose parent is outside the set treated
 * as a root — which is what the group leader itself always is, and what an
 * orphan reparented to launchd becomes.
 */
export function nest(procs: ProcInfo[]): ProcNode[] {
  const nodes = new Map(procs.map((proc) => [proc.pid, { ...proc, children: [] as ProcNode[] }]));
  const roots: ProcNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.ppid);
    if (parent === undefined || parent === node) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

/**
 * Signals every process in the group, not just its leader. A negative pid is the
 * whole point: `npm` forwards what it feels like forwarding, and an `oled` call
 * already in flight is a grandchild it has no handle on.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals): Result<void> {
  return tryExecute(() => void process.kill(-pgid, signal));
}

/**
 * The same snapshot, read synchronously. Stopping is decided in the same tick as
 * everything else the slot does, and an await in the middle of it would open the
 * very window the single-slot guard exists to close.
 */
export function listProcessesSync(): Result<ProcInfo[]> {
  const read = tryExecute(() =>
    execFileSync("ps", PS_ARGV, { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1_024 * 1_024 }),
  );
  if (!read.ok) return { ok: false, error: `ps did not run: ${read.error}` };
  return { ok: true, value: parsePs(read.value) };
}

/** The runner, however it was started; `npm start` and a bare `tsx src/main.ts` both reach it. */
export const RUNNER_COMMAND = /\bsrc\/main\.ts\b/;

/** Every live eval runner, which is what both a stop and an orphan check are really asking about. */
export function runnersIn(procs: ProcInfo[]): ProcInfo[] {
  return procs.filter((proc) => RUNNER_COMMAND.test(proc.command));
}

/** A login shell writes its own name with a leading dash; both spellings are refused. */
const SHELL_COMMAND = /^-?(?:ba|z|k|c|tc|fi|da)?sh$/;

function leaderIsShell(members: ProcInfo[], pgid: number): boolean {
  const leader = members.find((proc) => proc.pid === pgid);
  if (leader === undefined) return false;
  const head = leader.command.split(/\s+/)[0] ?? "";
  return SHELL_COMMAND.test(head.slice(head.lastIndexOf("/") + 1));
}

/**
 * Whether signalling this whole group would take only the run with it.
 *
 * An interactive shell puts each job in a group of its own, so a run started
 * with `npm start` is safely separable. A run started where there is no job
 * control — a script, a CI step, `sh -c` — can share its parent's group, and
 * signalling that would reach whatever else is in there. Refusing is cheap: the
 * caller falls back to the single pid, which is what it did before this existed.
 */
export function isSafeGroup(pgid: number, members: ProcInfo[], self: ProcInfo | null): Result<void> {
  if (pgid <= 1) return { ok: false, error: `${pgid} is not a process group worth signalling` };
  if (self !== null && (pgid === self.pid || pgid === self.pgid)) {
    return { ok: false, error: "that group is this dashboard's own" };
  }
  if (members.some((proc) => proc.pid === self?.pid)) {
    return { ok: false, error: "this dashboard is itself in that group" };
  }
  if (leaderIsShell(members, pgid)) {
    return { ok: false, error: `group ${pgid} is led by a shell, so it holds more than the run` };
  }
  if (!members.some((proc) => RUNNER_COMMAND.test(proc.command))) {
    return { ok: false, error: `group ${pgid} holds no eval runner` };
  }
  return { ok: true, value: undefined };
}

/** This process as ps sees it, so a group can be checked against it before being signalled. */
export function selfProc(procs: ProcInfo[]): ProcInfo | null {
  return procs.find((proc) => proc.pid === process.pid) ?? null;
}

/** Signal 0 sends nothing: it asks the OS whether that id names a process this user could signal at all. */
export function processExists(pid: number): boolean {
  return tryExecute(() => process.kill(pid, 0)).ok;
}

/** ps writes `T` for a job stopped by a signal; the flags that may follow say nothing about that. */
export function isStopped(proc: Pick<ProcInfo, "state">): boolean {
  return proc.state.startsWith("T");
}

/** Only the leader is asked for, so a poll costs one small ps rather than a scan of the whole table. */
const STATE_ARGV = (pid: number): string[] => ["-o", "stat=", "-p", String(pid)];

/**
 * Whether that run is frozen, asked of the OS rather than remembered.
 *
 * Deriving it means a paused run outlives the dashboard that paused it: a
 * restarted server finds the same `T` and offers to resume, and a run someone
 * continued from a terminal stops reading as paused at the next poll. Only the
 * group leader is read, because every signal this sends goes to the whole group
 * — so a stopped leader is a stopped run, and no state has to be kept in step.
 */
export function processStopped(pid: number): boolean {
  const read = tryExecute(() =>
    execFileSync("ps", STATE_ARGV(pid), { encoding: "utf8", timeout: PS_TIMEOUT_MS }),
  );
  // A process that has gone is not stopped; whether it existed at all is
  // processExists's question, asked separately and before this one.
  if (!read.ok) return false;
  return isStopped({ state: read.value.trim() });
}
