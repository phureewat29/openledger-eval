import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { debounce } from "es-toolkit";
import { FEED_FILE, type FeedLine } from "../report/feed.js";
import type { Channel } from "../shared/protocol.js";
import type {
  FeedPayload,
  LivePayload,
  ProcessesPayload,
  SandboxesPayload,
} from "../shared/payloads.js";
import type { Source } from "./channels.js";
import { createFeedTail, type FeedTail } from "./feed-tail.js";
import type { Launcher } from "./launch.js";
import { liveState, staysLive } from "./live-state.js";
import { groupOf, inGroup, listProcesses, nest, type ProcInfo, type ProcNode } from "./procs.js";
import { findIteration, newestLive, type LiveSnapshot } from "./reports-fs.js";
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
function readLivePayload(deps: WatchDeps, notice: string | null): LivePayload {
  const now = deps.now();
  const snapshot = newestLive(deps.reportsRoot);
  const live: LiveSnapshot | null = snapshot.ok ? snapshot.value : null;
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
    notice,
  };
}

/**
 * `updatedAt` advances on every heartbeat whether or not a cell moved, so
 * comparing the whole document would publish twelve identical payloads a minute.
 * Blanking it is the comparison that asks "did anything happen".
 */
function livePrint(payload: LivePayload): string {
  const doc = payload.doc === null ? null : { ...payload.doc, updatedAt: "" };
  return JSON.stringify({ ...payload, doc, notice: null });
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
  const pid = snapshot.ok ? snapshot.value?.doc.pid : undefined;
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
 * Publishes only what is new, and remembers the latest either way. Polling
 * sources sample on a timer whether or not anything moved — an idle `ps` every
 * two seconds is the common case — so a socket that carries only news is much
 * easier to reason about from the other end. `sampledAt` is left out of the
 * comparison, since it always differs.
 *
 * `latest` is what the registry hands a subscriber that arrived after the last
 * change: without it, staying quiet would leave that reader with nothing at all.
 */
function distinct<T extends { sampledAt: string }>(
  publish: (payload: unknown) => void,
): { emit: (payload: T) => void; latest: () => T | null } {
  let print = "";
  let last: T | null = null;
  return {
    emit(payload) {
      last = payload;
      const next = JSON.stringify({ ...payload, sampledAt: "" });
      if (next === print) return;
      print = next;
      publish(payload);
    },
    latest: () => last,
  };
}

function liveSource(deps: WatchDeps): Source {
  return (publish) => {
    let print = "";
    let last: LivePayload | null = null;
    const emit = (notice: string | null = null): void => {
      const payload = readLivePayload(deps, notice);
      last = payload;
      const next = livePrint(payload);
      if (next === print && notice === null) return;
      print = next;
      publish(payload);
    };

    const rescan = debounce(() => emit(), DEBOUNCE_MS, { edges: ["leading", "trailing"] });

    // Two watches, never one recursive sweep of reports/. A recursive watch would
    // fire on every runs/**/*.json the matrix writes — up to 129 KB apiece,
    // continuously — to learn something live.json already says.
    const watchers: FSWatcher[] = [];
    let watchedSlug: string | null = null;

    const repoint = (): void => {
      const snapshot = newestLive(deps.reportsRoot);
      const slug = snapshot.ok ? (snapshot.value?.slug ?? null) : null;
      if (slug === watchedSlug) return;
      watchedSlug = slug;
      // Index 1 by convention: the shallow watch on reports/ is index 0 and never
      // moves; only the iteration watch is torn down and re-aimed.
      watchers[1]?.close();
      watchers.length = 1;
      if (slug === null) return;
      const dir = join(deps.reportsRoot, slug);
      if (existsSync(dir)) watchers.push(watch(dir, () => rescan()));
    };

    if (existsSync(deps.reportsRoot)) {
      watchers.push(
        watch(deps.reportsRoot, () => {
          repoint();
          rescan();
        }),
      );
    }
    repoint();

    // The floor under fs.watch, and the clock that turns a silent run stale.
    const stopFloor = every(RESCAN_MS, () => emit());
    const stopClock = every(CLOCK_MS, () => emit());

    return {
      stop() {
        rescan.cancel();
        stopFloor();
        stopClock();
        for (const watcher of watchers) watcher.close();
      },
      current: () => last,
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

    const emit = (): void => {
      const snapshot = newestLive(deps.reportsRoot);
      const next = snapshot.ok ? (snapshot.value?.slug ?? null) : null;
      // A new iteration is a new file: start its reader from byte zero and tell
      // the client to replace rather than append.
      const changed = next !== slug;
      if (changed) {
        slug = next;
        tail = createFeedTail();
        ring = [];
      }
      if (slug === null) return;

      const read = tail.read(join(deps.reportsRoot, slug, FEED_FILE));
      if (!read.ok) return;
      if (read.value.lines.length === 0 && !changed) return;

      const reset = changed || read.value.reset;
      ring = (reset ? read.value.lines : [...ring, ...read.value.lines]).slice(-RING_MAX);
      offset = read.value.offset;
      publish({ slug, lines: read.value.lines, offset, reset } satisfies FeedPayload);
    };

    const stop = every(RESCAN_MS, emit);
    return {
      stop,
      current: () => (slug === null ? null : ({ slug, lines: ring, offset, reset: true } satisfies FeedPayload)),
    };
  };
}

function processesSource(deps: WatchDeps): Source {
  return (publish) => {
    const { emit: emitDistinct, latest } = distinct<ProcessesPayload>(publish);
    const emit = async (): Promise<void> => {
      const now = deps.now();
      const slot = deps.launcher.view();
      const snapshot = newestLive(deps.reportsRoot);
      const live = snapshot.ok ? snapshot.value : null;

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
    const { emit: emitDistinct, latest } = distinct<SandboxesPayload>(publish);
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
