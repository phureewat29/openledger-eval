import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { debounce } from "es-toolkit";
import type { FeedLine } from "../shared/feed.js";
import type { Channel } from "../shared/protocol.js";
import type {
  FeedPayload,
  LivePayload,
  ProcessesPayload,
  ProcInfo,
  SandboxesPayload,
} from "../shared/payloads.js";
import { FEED_FILE } from "../shared/paths.js";
import type { Source } from "./channels.js";
import { createFeedTail, type FeedTail } from "./feed-tail.js";
import type { Launcher } from "./launch/launcher.js";
import { liveState, staysLive } from "./live-state.js";
import { groupOf, inGroup, listProcesses, nest, type ProcNode } from "./procs.js";
import { findIteration, newestLive } from "./reports-fs.js";
import { listSandboxes, reclaimableBytes, sandboxRoot } from "./sandboxes.js";

// Where the dashboard learns that anything changed. The runner writes files and
// knows nothing about this process, so every fact here is read from disk or from
// `ps` — which means the only real design questions are how often to look, and
// how to avoid saying anything when nothing actually moved.

/** Long enough to collapse a burst of writes, short enough to feel immediate. */
const DEBOUNCE_MS = 120;

/**
 * fs.watch misses events on darwin under load and does not fire at all on some
 * mounts. This floor means the worst case degrades to what the old dashboard did
 * on every client — one local stat — rather than to a dead panel.
 */
const RESCAN_MS = 2_000;

/** Staleness is derived from the clock, never announced, so it needs its own tick. */
const CLOCK_MS = 1_000;

const PROCESS_MS = 2_000;

const SANDBOX_MS = 30_000;

export interface WatchDeps {
  reportsRoot: string;
  launcher: Launcher;
  now(): Date;
}

/** Everything the live payload is built from, gathered in one place per rescan. */
function readLivePayload(deps: WatchDeps): LivePayload {
  const now = deps.now();
  const live = newestLive(deps.reportsRoot);
  const slot = deps.launcher.view();
  const found = live === null ? null : findIteration(deps.reportsRoot, live.slug);
  // Asked once and answered three times. Each of these used to probe for itself,
  // which is a `ps` fork apiece, several times a second, for one fact.
  const paused = deps.launcher.frozen(live);
  return {
    kind: liveState(slot, live, now, paused).kind,
    slug: live?.slug ?? null,
    doc: live?.doc ?? null,
    hasBenchmark: found?.ok === true && found.value !== null ? found.value.hasBenchmark : false,
    slot,
    stop: deps.launcher.target(live, now, paused),
    hold: deps.launcher.holdTarget(live, now, paused),
  };
}

/**
 * `updatedAt` advances on every heartbeat whether or not a cell moved, so
 * comparing the whole document would publish twelve identical payloads a minute.
 * Blanking it is the comparison that asks "did anything happen".
 */
function livePrint(payload: LivePayload): string {
  const doc = payload.doc === null ? null : { ...payload.doc, updatedAt: "" };
  return JSON.stringify({ ...payload, doc });
}

/** Flattens the tree into rows the client indents by `depth` without walking anything. */
function flatten(nodes: ProcNode[], depth = 0): (ProcInfo & { depth: number })[] {
  return nodes.flatMap((node) => {
    const { children, ...proc } = node;
    return [{ ...proc, depth }, ...flatten(children, depth + 1)];
  });
}

/**
 * The group to show: the one this dashboard's own child leads, or — for a run
 * started at a terminal — the group the pid in its report belongs to.
 */
function activeGroup(deps: WatchDeps, procs: ProcInfo[]): number | null {
  const owned = deps.launcher.view().pgid;
  if (owned !== null) return owned;

  const snapshot = newestLive(deps.reportsRoot);
  const pid = snapshot?.doc.pid;
  return pid === undefined ? null : groupOf(procs, pid);
}

/**
 * A repeating job that also runs immediately. Every source is one of these, so
 * "start on the first subscriber, stop on the last" is the registry's business
 * and never each source's.
 */
function every(ms: number, run: () => void): () => void {
  run();
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Publishes only what is new, and remembers the latest either way. Sources
 * sample whether or not anything moved — an idle `ps` every two seconds is the
 * common case — so a socket that carries only news is much easier to reason
 * about from the other end. `print` is what "new" means for that payload: the
 * fields that always differ are left out of it.
 *
 * `latest` is what the registry hands a subscriber that arrived after the last
 * change: without it, staying quiet would leave that reader with nothing at all.
 */
function distinct<T>(
  publish: (payload: unknown) => void,
  print: (payload: T) => string,
): { emit: (payload: T) => void; latest: () => T | null } {
  let seen = "";
  let last: T | null = null;
  return {
    emit(payload) {
      last = payload;
      const next = print(payload);
      if (next === seen) return;
      seen = next;
      publish(payload);
    },
    latest: () => last,
  };
}

/** A poll's own timestamp always differs, and differing is not the same as having moved. */
function sampledPrint(payload: { sampledAt: string }): string {
  return JSON.stringify({ ...payload, sampledAt: "" });
}

function liveSource(deps: WatchDeps): Source {
  return (publish) => {
    const { emit: emitDistinct, latest } = distinct<LivePayload>(publish, livePrint);
    const emit = (): void => emitDistinct(readLivePayload(deps));

    const rescan = debounce(() => emit(), DEBOUNCE_MS, { edges: ["leading", "trailing"] });

    // Two watches, never one recursive sweep of reports/. A recursive watch would
    // fire on every runs/**/*.json the matrix writes — up to 129 KB apiece,
    // continuously — to learn something live.json already says.
    let iterationWatcher: FSWatcher | null = null;
    let watchedSlug: string | null = null;

    const repoint = (): void => {
      const snapshot = newestLive(deps.reportsRoot);
      const slug = snapshot?.slug ?? null;
      if (slug === watchedSlug) return;
      watchedSlug = slug;
      iterationWatcher?.close();
      iterationWatcher = null;
      if (slug === null) return;
      const dir = join(deps.reportsRoot, slug);
      if (existsSync(dir)) iterationWatcher = watch(dir, () => rescan());
    };

    // The shallow watch on reports/ never moves; only the iteration watch above
    // is torn down and re-aimed, at whichever run is newest.
    const rootWatcher = existsSync(deps.reportsRoot)
      ? watch(deps.reportsRoot, () => {
          repoint();
          rescan();
        })
      : null;
    repoint();

    // The floor under fs.watch, and the clock that turns a silent run stale.
    const stopFloor = every(RESCAN_MS, () => emit());
    const stopClock = every(CLOCK_MS, () => emit());

    return {
      stop() {
        rescan.cancel();
        stopFloor();
        stopClock();
        rootWatcher?.close();
        iterationWatcher?.close();
      },
      current: latest,
    };
  };
}

/** Enough scrollback for a reader who just arrived, bounded so a long matrix cannot grow it. */
const RING_MAX = 500;

function feedSource(deps: WatchDeps): Source {
  return (publish) => {
    let slug: string | null = null;
    let tail: FeedTail = createFeedTail();
    // The window itself, not just the last delta: what goes over the wire while
    // a run is going is an append, but a reader joining midway needs the whole
    // thing at once.
    let ring: FeedLine[] = [];
    let offset = 0;
    let error: string | null = null;

    const emit = (): void => {
      const snapshot = newestLive(deps.reportsRoot);
      const next = snapshot?.slug ?? null;
      // A new iteration is a new file: start its reader from byte zero and tell
      // the client to replace rather than append.
      const changed = next !== slug;
      if (changed) {
        slug = next;
        tail = createFeedTail();
        ring = [];
        error = null;
      }
      if (slug === null) return;

      const read = tail.read(join(deps.reportsRoot, slug, FEED_FILE));
      // A file that cannot be read stays unreadable while whatever broke it
      // lasts, so a failure is said once and so is its ending, rather than
      // either being repeated at every poll.
      if (!read.ok) {
        const news = read.error !== error;
        error = read.error;
        if (news) publish({ slug, lines: [], offset, reset: false, error } satisfies FeedPayload);
        return;
      }
      const recovered = error !== null;
      error = null;
      if (read.value.lines.length === 0 && !changed && !recovered) return;

      const reset = changed || read.value.reset;
      ring = (reset ? read.value.lines : [...ring, ...read.value.lines]).slice(-RING_MAX);
      offset = read.value.offset;
      publish({ slug, lines: read.value.lines, offset, reset, error: null } satisfies FeedPayload);
    };

    const stop = every(RESCAN_MS, emit);
    return {
      stop,
      current: () =>
        slug === null ? null : ({ slug, lines: ring, offset, reset: true, error } satisfies FeedPayload),
    };
  };
}

function processesSource(deps: WatchDeps): Source {
  return (publish) => {
    const { emit: emitDistinct, latest } = distinct<ProcessesPayload>(publish, sampledPrint);
    const emit = async (): Promise<void> => {
      const now = deps.now();
      const slot = deps.launcher.view();
      const live = newestLive(deps.reportsRoot);

      // Nothing is running, so nothing is worth a `ps`. One empty tree says so.
      if (!staysLive(liveState(slot, live, now), slot)) {
        emitDistinct({ pgid: null, rows: [], sampledAt: now.toISOString(), error: null } satisfies ProcessesPayload);
        return;
      }

      const procs = await listProcesses();
      if (!procs.ok) {
        emitDistinct({ pgid: null, rows: [], sampledAt: now.toISOString(), error: procs.error } satisfies ProcessesPayload);
        return;
      }

      const pgid = activeGroup(deps, procs.value);
      const rows = pgid === null ? [] : flatten(nest(inGroup(procs.value, pgid)));
      emitDistinct({ pgid, rows, sampledAt: now.toISOString(), error: null } satisfies ProcessesPayload);
    };

    return { stop: every(PROCESS_MS, () => void emit()), current: latest };
  };
}

function sandboxesSource(deps: WatchDeps): Source {
  return (publish) => {
    const { emit: emitDistinct, latest } = distinct<SandboxesPayload>(publish, sampledPrint);
    const emit = async (): Promise<void> => {
      const now = deps.now();
      const procs = await listProcesses();
      const listed = await listSandboxes(sandboxRoot(), procs.ok ? procs.value : [], now);
      if (!listed.ok) {
        emitDistinct({
          entries: [],
          reclaimableBytes: 0,
          sampledAt: now.toISOString(),
          error: listed.error,
        } satisfies SandboxesPayload);
        return;
      }
      emitDistinct({
        entries: listed.value,
        reclaimableBytes: reclaimableBytes(listed.value),
        sampledAt: now.toISOString(),
        error: null,
      } satisfies SandboxesPayload);
    };

    return { stop: every(SANDBOX_MS, () => void emit()), current: latest };
  };
}

export function createSources(deps: WatchDeps): Record<Channel, Source> {
  return {
    live: liveSource(deps),
    feed: feedSource(deps),
    processes: processesSource(deps),
    sandboxes: sandboxesSource(deps),
  };
}
