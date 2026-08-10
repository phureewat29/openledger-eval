import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import type { PlannedRun } from "../runner/matrix.js";
import { LIVE_FILE } from "../shared/paths.js";
import type { ConfigEcho } from "./benchmark.js";
import {
  isSameItem,
  keyOfRecord,
  liveItemOf,
  pendingItem,
  type ItemKey,
  type LiveItem,
} from "./live-item.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { SCHEMA_VERSION } from "./schema.js";
import { warnOnce } from "./warn.js";

// The runner's mid-flight status, written to reports/<ts>/live.json while a
// matrix runs so a separate reader (the dashboard) can watch it progress
// without touching anything the CLI itself reads or writes.

/** `updatedAt` is a heartbeat, not just a transition marker: it advances on every write, idle beats included. */
export interface LiveDoc {
  schemaVersion: 1;
  status: "running" | "done";
  /** When the iteration began, which a rerun merging into it does not change. */
  startedAt: string;
  /**
   * When the process now writing this took the iteration up — the same as
   * `startedAt` for an ordinary run, and later for a rerun.
   *
   * The two are separate because a dashboard decides whether a live.json belongs
   * to the child it just spawned by comparing timestamps: read against
   * `startedAt`, a rerun's document looks older than the launch that made it and
   * the run reads as forever "starting".
   */
  openedAt: string;
  updatedAt: string;
  /**
   * The runner's own process id, which is what lets anyone who can read this
   * directory stop the run — the dashboard that spawned it, another one, or a
   * hand at a terminal.
   */
  pid: number;
  identity: RunIdentity;
  config: ConfigEcho;
  /** One per PlannedRun, in plan order; the array's length and order never change after this. */
  items: LiveItem[];
}

/** Three missed five-second heartbeats: the line between a slow run and a dead one. */
const STALE_MS = 15_000;

/** Clamped at zero: a report written by a machine whose clock runs ahead is silent for no time at all. */
export function silentMs(doc: LiveDoc, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(doc.updatedAt));
}

/** The one authority on "a run is still going": the dashboard reads it to poll, to refuse a second launch, and to render. */
export function isRunningFresh(doc: LiveDoc, now: Date): boolean {
  return doc.status === "running" && silentMs(doc, now) <= STALE_MS;
}

function keyOfPlanned(planned: PlannedRun): ItemKey {
  return { model: planned.model.id, suite: planned.suite.id, caseId: planned.kase.id, trial: planned.trial };
}

/** Rebuilds `items` with one entry replaced; every other item is returned as-is. */
function withItem(doc: LiveDoc, key: ItemKey, update: (item: LiveItem) => LiveItem): LiveDoc {
  return { ...doc, items: doc.items.map((item) => (isSameItem(item, key) ? update(item) : item)) };
}

/** Every planned cell starts pending, in plan order; the matrix has not run anything yet. */
export function buildLiveDoc(identity: RunIdentity, config: ConfigEcho, plan: PlannedRun[], now: Date): LiveDoc {
  const nowIso = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "running",
    startedAt: nowIso,
    openedAt: nowIso,
    updatedAt: nowIso,
    pid: process.pid,
    identity,
    config,
    items: plan.map((planned) => pendingItem(keyOfPlanned(planned))),
  };
}

export function markRunning(doc: LiveDoc, planned: PlannedRun): LiveDoc {
  return withItem(doc, keyOfPlanned(planned), (item) => ({ ...item, state: "running" }));
}

export function markFinished(doc: LiveDoc, record: RunRecord): LiveDoc {
  return withItem(doc, keyOfRecord(record), () => liveItemOf(record));
}

/**
 * An existing iteration reopened for a rerun: every cell the report already
 * holds, replayed onto the grid, with the cells this plan will measure again
 * taken back to pending.
 *
 * Built from the report's own run records rather than from its live.json,
 * because live.json is not committed and a report cloned or archived without it
 * must still reopen. A cell the report never held is appended — `withItem` is a
 * no-op for a key it cannot find, so a newly-added case missing from `items`
 * would run to completion without the grid ever drawing it. `startedAt` is the
 * report's, so a merged iteration keeps saying when it began rather than when it
 * was last touched.
 */
export function reopenLiveDoc(
  identity: RunIdentity,
  config: ConfigEcho,
  prior: RunRecord[],
  plan: PlannedRun[],
  startedAt: string,
  now: Date,
): LiveDoc {
  const priorKeys = prior.map(keyOfRecord);
  const planKeys = plan.map(keyOfPlanned);
  const keys = [...priorKeys, ...planKeys.filter((key) => !priorKeys.some((held) => isSameItem(held, key)))];

  const empty: LiveDoc = {
    schemaVersion: SCHEMA_VERSION,
    status: "running",
    startedAt,
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    pid: process.pid,
    identity,
    config,
    items: keys.map(pendingItem),
  };

  const replayed = prior.reduce(markFinished, empty);
  return {
    ...replayed,
    items: replayed.items.map((item) => {
      const planned = planKeys.find((key) => isSameItem(item, key));
      return planned === undefined ? item : pendingItem(planned);
    }),
  };
}

export function finalizeDoc(doc: LiveDoc): LiveDoc {
  return { ...doc, status: "done" };
}

/** Same-directory rename is one filesystem operation, so a reader mid-poll never sees a torn write. */
export function writeLive(dir: string, doc: LiveDoc): Result<void> {
  const path = join(dir, LIVE_FILE);
  const written = tryExecute(() => {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  });
  if (!written.ok) return { ok: false, error: `cannot write ${path}: ${written.error}` };
  return { ok: true, value: undefined };
}

export interface LiveWriter {
  start(planned: PlannedRun): void;
  finish(record: RunRecord): void;
  finalize(): void;
}

const HEARTBEAT_MS = 5_000;

/**
 * Owns the current LiveDoc and persists it on every transition, plus every
 * 5s of idle time, so a reader can tell a slow-but-alive run from a dead one.
 * A write failure is reported once via `warnOnce` and retried silently after.
 */
export function createLiveWriter(dir: string, initialDoc: LiveDoc): LiveWriter {
  let doc = initialDoc;
  const warn = warnOnce();

  function persist(): void {
    const written = writeLive(dir, doc);
    if (!written.ok) warn(`${written.error}; will keep retrying silently`);
  }

  function commit(next: LiveDoc): void {
    doc = { ...next, updatedAt: new Date().toISOString() };
    persist();
  }

  commit(doc);
  const heartbeat = setInterval(() => commit(doc), HEARTBEAT_MS);
  heartbeat.unref();

  return {
    start(planned) {
      commit(markRunning(doc, planned));
    },
    finish(record) {
      commit(markFinished(doc, record));
    },
    finalize() {
      clearInterval(heartbeat);
      commit(finalizeDoc(doc));
    },
  };
}
