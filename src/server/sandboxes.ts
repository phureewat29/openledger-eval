import { sumBy } from "es-toolkit";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import { execCapture } from "../oled/command.js";
import { runnersIn, type ProcInfo } from "./procs.js";

// Every run mkdtemps a workspace under the system temp directory and the
// workspace guard removes it on the way out. A SIGKILL never reaches that guard,
// so the directory outlives the run that made it — hundreds of megabytes of npm
// install per abandoned matrix, in a place nothing ever looks.

/** The prefix `createWorkspace` mkdtemps with; nothing else here is ours to touch. */
export const SANDBOX_PREFIX = "oled-eval-";

const DU_TIMEOUT_MS = 20_000;

/** `du -sk` reports kibibytes; one call covers every path, which matters at eighty of them. */
const DU_UNIT = 1_024;

const DU_LINE = /^(\d+)\s+(.*)$/;

/** How a sandbox was judged to belong to something, so the panel can say why. */
export type Owner = "argv" | "runner" | "none";

export interface SandboxInfo {
  path: string;
  name: string;
  bytes: number;
  /** Since the directory was made, which for an abandoned sandbox is when its run began. */
  ageMs: number;
  /** Whatever still owns it, or `none` — the only value cleanup will act on. */
  owner: Owner;
}

export function isOrphan(entry: SandboxInfo): boolean {
  return entry.owner === "none";
}

/**
 * When each live runner started. A process's own elapsed time is the only clock
 * available here, and it is the right one: both numbers are read on this machine
 * against this machine's clock, so no skew can creep between them.
 */
function runnerStarts(procs: ProcInfo[], now: Date): number[] {
  return runnersIn(procs).map((proc) => now.getTime() - proc.elapsedSec * 1_000);
}

/**
 * Two rules, because one is not enough to be safe.
 *
 * The sandbox path reaches a command's argv through `--db`, `--data-dir`,
 * `--cache-dir` and npm's `--prefix`, so a substring test finds a sandbox that
 * is being written to right now. But a run spends most of its life waiting on
 * the model with no `oled` process alive at all, and by that test alone its
 * sandbox would read as abandoned — and be offered for deletion underneath it.
 *
 * So a sandbox is also in use when any live runner started before the sandbox
 * was created: a runner older than the directory is the only thing that could
 * have made it. Between them the two rules cover a run whether or not it happens
 * to be executing a command at the moment anyone looks.
 */
export function ownerOf(path: string, birthMs: number, procs: ProcInfo[], now: Date): Owner {
  if (procs.some((proc) => proc.command.includes(path))) return "argv";
  if (runnerStarts(procs, now).some((startedAt) => startedAt <= birthMs)) return "runner";
  return "none";
}

/** Sizes for many paths in one `du`, because eighty separate walks is the slow way to say 271 MB. */
async function sizesOf(paths: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (paths.length === 0) return sizes;

  const result = await execCapture("du", ["-sk", ...paths], { timeoutMs: DU_TIMEOUT_MS });
  // du exits nonzero on a directory it could not fully read and still prints the
  // rest, so its output is read either way and a missing path simply has no size.
  if (!result.ok) return sizes;
  for (const line of result.value.stdout.split("\n")) {
    const match = DU_LINE.exec(line);
    if (match === null) continue;
    const [, kib, path] = match;
    if (path !== undefined) sizes.set(path, Number(kib) * DU_UNIT);
  }
  return sizes;
}

export function sandboxRoot(): string {
  return tmpdir();
}

/** Newest first, so the one a reader is most likely asking about is at the top. */
export async function listSandboxes(
  root: string,
  procs: ProcInfo[],
  now: Date,
): Promise<Result<SandboxInfo[]>> {
  const entries = tryExecute(() => readdirSync(root, { withFileTypes: true }));
  if (!entries.ok) return { ok: false, error: `cannot read ${root}: ${entries.error}` };

  const paths = entries.value
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SANDBOX_PREFIX))
    .map((entry) => join(root, entry.name));

  const sizes = await sizesOf(paths);
  const found: SandboxInfo[] = [];
  for (const path of paths) {
    const stat = tryExecute(() => statSync(path));
    // Removed between the readdir and the stat: it is gone, which is the state
    // this panel exists to reach anyway.
    if (!stat.ok) continue;
    // birthtime is what the runner-window rule needs — when the sandbox was
    // made, not when it was last touched, which a live run keeps advancing.
    const birthMs = stat.value.birthtimeMs || stat.value.mtimeMs;
    found.push({
      path,
      name: path.slice(root.length + 1),
      bytes: sizes.get(path) ?? 0,
      ageMs: Math.max(0, now.getTime() - birthMs),
      owner: ownerOf(path, birthMs, procs, now),
    });
  }
  return { ok: true, value: found.toSorted((a, b) => a.ageMs - b.ageMs) };
}

export function reclaimableBytes(entries: SandboxInfo[]): number {
  return sumBy(entries.filter(isOrphan), (entry) => entry.bytes);
}

/**
 * Two guards before an `rm -rf`, both on the resolved path rather than the one
 * handed in: it has to sit directly under the root this listed, and it has to
 * carry the prefix only `createWorkspace` writes. A path that fails either is a
 * bug or an attack, and both are refused the same way.
 */
export function removeSandbox(root: string, path: string): Result<void> {
  // resolve() collapses any `..` first, so a traversal either leaves the root —
  // caught here — or leaves a separator in the name, caught just below.
  const prefix = `${resolve(root)}/`;
  const full = resolve(path);
  if (!full.startsWith(prefix)) return { ok: false, error: `${path} is not under ${root}` };

  const name = full.slice(prefix.length);
  if (name.includes("/") || !name.startsWith(SANDBOX_PREFIX)) {
    return { ok: false, error: `${name} is not a sandbox directory` };
  }
  const removed = tryExecute(() => rmSync(full, { recursive: true, force: true }));
  if (!removed.ok) return { ok: false, error: `cannot remove ${name}: ${removed.error}` };
  return { ok: true, value: undefined };
}
