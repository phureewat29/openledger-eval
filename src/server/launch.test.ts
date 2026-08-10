import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveDoc } from "../report/live.js";
import type { RunIdentity } from "../report/record.js";
import type { SlotView, StopTarget } from "../shared/payloads.js";
import { createLauncher, type ChildHandle } from "./launch/launcher.js";
import {
  parseLaunchRequest,
  parseRerunRequest,
  rerunArgs,
  spawnArgs,
  type LaunchRequest,
} from "./launch/request.js";
import { busyReason, IDLE_SLOT, launchFailed, ownsRun, pauseTarget, runPid, stopTarget } from "./launch/slot.js";
import type { LiveSnapshot } from "./reports-fs.js";

const NOW = new Date("2026-08-07T05:00:00.000Z");

const MODEL_IDS = ["a/model", "b/model"];

const REQUEST: LaunchRequest = { suites: ["query"], models: ["a/model"] };

const IDENTITY: RunIdentity = {
  startedAt: "2026-08-07T04:44:10.327Z",
  oledVersion: "0.20.1",
  suiteSha256: "94270f6a3338",
  skillVersion: "0.20.1",
  skillSha256: "2120973bc677",
  evalVersion: "1.0.0",
};

function beat(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1_000).toISOString();
}

/** The pid a fabricated run claims; the probe below is the only thing that ever looks at it. */
const RUN_PID = 4242;

/** The group a launched child leads, distinct from RUN_PID so the two can never be confused. */
const CHILD_PID = 7373;

function snapshot(
  status: LiveDoc["status"],
  updatedAt: string,
  startedAt = IDENTITY.startedAt,
  pid: number | undefined = RUN_PID,
): LiveSnapshot {
  return {
    slug: "2026-08-07-1144",
    doc: {
      schemaVersion: 1,
      status,
      startedAt,
      openedAt: startedAt,
      updatedAt,
      pid,
      identity: IDENTITY,
      config: { suites: ["query"], trials: 1, concurrency: 1, modelsRequested: MODEL_IDS },
      items: [],
    },
  };
}

/** Stands in for `process.kill(pid, 0)`: only the fabricated run answers, and no real process is touched. */
const runExists = (pid: number): boolean => pid === RUN_PID;

const NOTHING: StopTarget = { kind: "none" };

interface FakeChild {
  handle: ChildHandle;
  signals: NodeJS.Signals[];
  exit(code: number | null): void;
}

/** Stands in for a process group: the slot only ever signals one and waits to hear it ended. */
function fakeChild(pid = CHILD_PID): FakeChild {
  const signals: NodeJS.Signals[] = [];
  const listeners: ((code: number | null) => void)[] = [];
  return {
    handle: {
      pid,
      kill: (signal) => void signals.push(signal),
      onExit: (listener) => void listeners.push(listener),
    },
    signals,
    exit: (code) => listeners.forEach((listener) => listener(code)),
  };
}

function harness(tail = "") {
  const children: FakeChild[] = [];
  const started: string[][] = [];
  const interrupted: number[] = [];
  const launcher = createLauncher({
    start(args) {
      started.push(args);
      const child = fakeChild();
      children.push(child);
      return { ok: true, value: child.handle };
    },
    tail: () => tail,
    exists: runExists,
    interrupt(pid) {
      interrupted.push(pid);
      return { ok: true, value: undefined };
    },
    hold: () => ({ ok: true, value: undefined }),
    stopped: () => false,
  });
  return { launcher, children, started, interrupted };
}

test("takes the suites and models ticked, without repeats", () => {
  const parsed = parseLaunchRequest(new URLSearchParams("suite=query&suite=query&model=a/model&model=a/model"), MODEL_IDS);
  assert.deepEqual(parsed, { ok: true, value: { suites: ["query"], models: ["a/model"] } });
});

// One run per case is not negotiable from a form, so a posted trial count is
// ignored rather than honoured: the matrix can never be doubled from the browser.
test("ignores a trial count a hand-made post tries to smuggle in", () => {
  const parsed = parseLaunchRequest(new URLSearchParams("suite=query&model=a/model&trials=9"), MODEL_IDS);
  assert.deepEqual(parsed, { ok: true, value: { suites: ["query"], models: ["a/model"] } });
});

test("every suite ticked is the CLI's own word for all", () => {
  const parsed = parseLaunchRequest(
    new URLSearchParams("suite=ingest&suite=record&suite=query&model=a/model"),
    MODEL_IDS,
  );
  assert.deepEqual(parsed, { ok: true, value: { suites: ["ingest", "record", "query"], models: ["a/model"] } });
  assert.ok(parsed.ok && spawnArgs(parsed.value).includes("all"));
});

test("refuses everything a form could carry that spawn must never see", () => {
  const refused = [
    "model=a/model",
    "suite=&model=a/model",
    "suite=nope&model=a/model",
    "suite=query",
    "suite=query&model=",
    "suite=query&model=x/evil",
    "suite=query&model=--concurrency",
    "suite=query&model=a/model&model=x/evil",
  ];
  for (const query of refused) {
    assert.equal(parseLaunchRequest(new URLSearchParams(query), MODEL_IDS).ok, false, query);
  }
});

// Some but not all ticked has no shorthand, so it goes as one flag per suite:
// the argv a person picking those same boxes at a terminal would have typed.
test("builds the argv a terminal run would have used", () => {
  assert.deepEqual(spawnArgs({ suites: ["ingest", "query"], models: ["a/model", "b/model"] }), [
    "run",
    "eval",
    "--",
    "--suite",
    "ingest",
    "--suite",
    "query",
    "--model",
    "a/model",
    "--model",
    "b/model",
  ]);
});

// The CLI has no --trials flag, so an argv carrying one would fail every launch
// as an unknown flag rather than run a second trial.
test("never asks the CLI for a trial count", () => {
  assert.ok(!spawnArgs({ suites: ["ingest", "query"], models: ["a/model"] }).includes("--trials"));
});

test("calls a launch busy while any run is beating, and free once one goes quiet", () => {
  assert.equal(busyReason(IDLE_SLOT, null, NOW), null);
  assert.equal(busyReason(IDLE_SLOT, snapshot("done", beat(1)), NOW), null);
  assert.equal(busyReason(IDLE_SLOT, snapshot("running", beat(40)), NOW), null, "a dead run holds nothing");
  assert.ok(busyReason(IDLE_SLOT, snapshot("running", beat(2)), NOW)?.includes("2026-08-07-1144"));
  assert.ok(busyReason({ ...IDLE_SLOT, alive: true }, null, NOW) !== null);
});

test("tells its own run's live.json from one an earlier run left behind", () => {
  const slot = { ...IDLE_SLOT, launchedAt: "2026-08-07T04:50:00.000Z" };
  assert.equal(ownsRun(slot, snapshot("running", beat(1))), false);
  assert.equal(ownsRun(slot, snapshot("running", beat(1), "2026-08-07T04:51:00.000Z")), true);
  assert.equal(ownsRun(slot, null), false);
  assert.equal(ownsRun(IDLE_SLOT, snapshot("running", beat(1))), false);
});

test("a rerun's own live.json is its launcher's, though the iteration it merges into is older", () => {
  // The whole of the bug this pins: a rerun inherits the iteration's startedAt,
  // which predates the launch that made it. Read against that, the run reads as
  // forever "starting" and its grid never appears.
  const slot = { ...IDLE_SLOT, launchedAt: "2026-08-07T04:50:00.000Z" };
  const reopened = snapshot("running", beat(1), "2026-08-01T09:00:00.000Z");
  assert.equal(ownsRun(slot, reopened), false);

  const withOpenedAt: LiveSnapshot = {
    ...reopened,
    doc: { ...reopened.doc, openedAt: "2026-08-07T04:51:00.000Z" },
  };
  assert.equal(ownsRun(slot, withOpenedAt), true);
});

/**
 * A matrix killed outright leaves `status: "running"` on disk for ever. Probing
 * that pid is a `ps` fork, and the live payload is rebuilt more than once a
 * second — so without the existence check an idle dashboard nobody is looking at
 * forks indefinitely. Existence and not freshness, because a paused run stops
 * heartbeating on purpose and must still be found.
 */
test("does not probe a run whose process is gone, however much its report still says running", () => {
  const dead = snapshot("running", beat(600));
  assert.equal(runPid(IDLE_SLOT, dead, () => false), null);
});

test("still probes a run that has stopped beating but whose process is there, which is what paused looks like", () => {
  const frozen = snapshot("running", beat(600));
  assert.equal(runPid(IDLE_SLOT, frozen, () => true), RUN_PID);
});

test("asks nothing of a finished report", () => {
  assert.equal(runPid(IDLE_SLOT, snapshot("done", beat(1)), () => true), null);
  assert.equal(runPid(IDLE_SLOT, null, () => true), null);
});

test("counts any end but zero as a failed launch, a signal included", () => {
  const at = beat(1);
  assert.equal(launchFailed(IDLE_SLOT), false);
  assert.equal(launchFailed({ ...IDLE_SLOT, exit: { code: 0, at } }), false);
  assert.equal(launchFailed({ ...IDLE_SLOT, exit: { code: 1, at } }), true);
  assert.equal(launchFailed({ ...IDLE_SLOT, exit: { code: null, at } }), true);
});

test("claims the slot on launch and reports its child alive", () => {
  const { launcher, started, children } = harness();
  assert.deepEqual(launcher.view(), IDLE_SLOT);

  assert.deepEqual(launcher.launch(REQUEST, null, NOW), { ok: true });
  assert.deepEqual(started, [["run", "eval", "--", "--suite", "query", "--model", "a/model"]]);
  assert.equal(children.length, 1);

  const view = launcher.view();
  assert.equal(view.alive, true);
  assert.equal(view.launchedAt, NOW.toISOString());
  assert.equal(view.exit, null);
  assert.equal(view.stoppedAt, null);
});

test("carries the group its child leads, so the tree and the stop reach every process of the run", () => {
  const { launcher } = harness();
  assert.equal(launcher.view().pgid, null);

  launcher.launch(REQUEST, null, NOW);
  // Spawned detached, so the child is its own group leader and its pid is the pgid.
  assert.equal(launcher.view().pgid, CHILD_PID);
});

test("refuses a second launch while its child is alive, and takes one after it ends", () => {
  const { launcher, children } = harness();
  launcher.launch(REQUEST, null, NOW);

  const second = launcher.launch(REQUEST, null, NOW);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "busy");
  assert.equal(children.length, 1, "the refused launch spawned nothing");

  children[0]?.exit(0);
  assert.equal(launcher.view().alive, false);
  assert.equal(launcher.launch(REQUEST, null, NOW).ok, true);
  assert.equal(children.length, 2);
  assert.equal(launcher.view().exit, null, "a fresh claim carries none of the last child's state");
});

test("records how a child ended and reads the log only for one that ended badly", () => {
  const { launcher, children } = harness("npm error could not determine executable");
  launcher.launch(REQUEST, null, NOW);
  children[0]?.exit(1);

  const view = launcher.view();
  assert.equal(view.alive, false);
  assert.equal(view.exit?.code, 1);
  assert.equal(view.tail, "npm error could not determine executable");
});

test("leaves the log unread when the child ended cleanly", () => {
  const { launcher, children } = harness("noise");
  launcher.launch(REQUEST, null, NOW);
  children[0]?.exit(0);
  assert.equal(launcher.view().tail, "");
});

test("keeps the slot empty when the child cannot be started at all", () => {
  const launcher = createLauncher({
    start: () => ({ ok: false, error: "cannot open the log" }),
    tail: () => "",
    exists: runExists,
    interrupt: () => ({ ok: true, value: undefined }),
    hold: () => ({ ok: true, value: undefined }),
    stopped: () => false,
  });
  assert.deepEqual(launcher.launch(REQUEST, null, NOW), {
    ok: false,
    reason: "spawn",
    message: "cannot open the log",
  });
  assert.deepEqual(launcher.view(), IDLE_SLOT);
});

test("stops its own child with one SIGINT, and does nothing when it owns none", () => {
  const { launcher, children } = harness();
  assert.equal(launcher.stop(null, NOW).ok, false, "there is nothing to stop before a launch");

  launcher.launch(REQUEST, null, NOW);
  assert.deepEqual(launcher.stop(null, NOW), { ok: true });
  assert.deepEqual(children[0]?.signals, ["SIGINT"]);
  assert.equal(launcher.view().stoppedAt, NOW.toISOString());

  const second = launcher.stop(null, NOW);
  assert.equal(second.ok, false, "a second stop must not signal a child that is already going down");
  assert.equal(second.ok === false && second.reason, "idle");
  assert.deepEqual(children[0]?.signals, ["SIGINT"]);

  children[0]?.exit(130);
  assert.equal(launcher.stop(null, NOW).ok, false);
  assert.equal(launcher.view().alive, false);
  assert.equal(launcher.view().exit?.code, 130);
});

test("resolves a stop against the run, its own child first and the newest live.json after", () => {
  const fresh = snapshot("running", beat(2));
  const owned = { ...IDLE_SLOT, alive: true };

  assert.deepEqual(stopTarget(owned, null, NOW, runExists), { kind: "owned" }, "a child that has written nothing yet");
  assert.deepEqual(stopTarget(owned, fresh, NOW, runExists), { kind: "owned" }, "its own child outranks the file");
  assert.deepEqual(stopTarget(IDLE_SLOT, fresh, NOW, runExists), { kind: "foreign", pid: RUN_PID });
});

test("offers nothing to stop for a run that is finished, quiet, nameless or gone", () => {
  assert.deepEqual(stopTarget(IDLE_SLOT, null, NOW, runExists), NOTHING, "no live.json at all");
  assert.deepEqual(stopTarget(IDLE_SLOT, snapshot("done", beat(1)), NOW, runExists), NOTHING, "a finished run");
  assert.deepEqual(stopTarget(IDLE_SLOT, snapshot("running", beat(40)), NOW, runExists), NOTHING, "a stale heartbeat");
  assert.deepEqual(stopTarget(IDLE_SLOT, snapshot("running", beat(2)), NOW, () => false), NOTHING, "a pid gone quiet");
});

// Otherwise the escalation this dashboard already scheduled would run beside a
// second interrupt aimed straight at the eval process out of its own live.json.
test("stops offering a child it has already signalled, whatever its live.json still says", () => {
  const stopping = { ...IDLE_SLOT, alive: true, stoppedAt: beat(1) };
  assert.deepEqual(stopTarget(stopping, snapshot("running", beat(1)), NOW, runExists), NOTHING);
});

test("interrupts a run it never spawned by the pid that run wrote down", () => {
  const { launcher, children, interrupted } = harness();
  const fresh = snapshot("running", beat(2));

  assert.deepEqual(launcher.target(fresh, NOW, false), { kind: "foreign", pid: RUN_PID });
  assert.deepEqual(launcher.stop(fresh, NOW), { ok: true });
  assert.deepEqual(interrupted, [RUN_PID], "one SIGINT, since there is no handle to escalate against");
  assert.equal(children.length, 0);
  assert.deepEqual(launcher.view(), IDLE_SLOT, "a foreign stop is not this dashboard's to record");
});

test("reports a foreign signal it could not send rather than claiming the run stopped", () => {
  const launcher = createLauncher({
    start: () => ({ ok: false, error: "unused" }),
    tail: () => "",
    exists: runExists,
    interrupt: () => ({ ok: false, error: "kill ESRCH" }),
    hold: () => ({ ok: true, value: undefined }),
    stopped: () => false,
  });

  const stopped = launcher.stop(snapshot("running", beat(2)), NOW);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.ok === false && stopped.reason, "signal");
  assert.ok(stopped.ok === false && stopped.message.includes(String(RUN_PID)));
});

test("rerunArgs names a single case with one --case flag", () => {
  assert.deepEqual(rerunArgs({ slug: "2026-08-07-1144", model: "a/model", suite: "query", cases: ["c1"] }), [
    "run",
    "eval",
    "--",
    "--into",
    "2026-08-07-1144",
    "--suite",
    "query",
    "--model",
    "a/model",
    "--case",
    "c1",
  ]);
});

test("rerunArgs with an empty cases array reruns the whole row, without any --case flag", () => {
  assert.deepEqual(rerunArgs({ slug: "2026-08-07-1144", model: "a/model", suite: "query", cases: [] }), [
    "run",
    "eval",
    "--",
    "--into",
    "2026-08-07-1144",
    "--suite",
    "query",
    "--model",
    "a/model",
  ]);
});

test("parseRerunRequest refuses a suite that is not ours", () => {
  const result = parseRerunRequest("2026-08-07-1144", { model: "a/model", suite: "nope" }, MODEL_IDS);
  assert.equal(result.ok, false);
});

test("parseRerunRequest refuses a model that is not among the given ids", () => {
  const result = parseRerunRequest("2026-08-07-1144", { model: "x/evil", suite: "query" }, MODEL_IDS);
  assert.equal(result.ok, false);
});

test("parseRerunRequest refuses a case id that is not a plain slug", () => {
  for (const cases of [["--evil"], ["a/b"]]) {
    const result = parseRerunRequest("2026-08-07-1144", { model: "a/model", suite: "query", cases }, MODEL_IDS);
    assert.equal(result.ok, false, JSON.stringify(cases));
  }
});

test("pauseTarget offers nothing to hold when there is nothing to stop", () => {
  assert.deepEqual(pauseTarget({ kind: "none" }, IDLE_SLOT, false, true), { kind: "none" });
});

test("pauseTarget offers pause for a reachable run that is not frozen, and resume for one that is", () => {
  const stop: StopTarget = { kind: "foreign", pid: RUN_PID };
  assert.deepEqual(pauseTarget(stop, IDLE_SLOT, false, true), { kind: "pause", owned: false, pid: RUN_PID });
  assert.deepEqual(pauseTarget(stop, IDLE_SLOT, true, true), { kind: "resume", owned: false, pid: RUN_PID });
});

/**
 * Freezing a child that is still packing leaves nothing on disk naming its pid,
 * so a restarted dashboard would find a stopped process it cannot address and
 * the run would have to be continued from a terminal. Nothing is in flight that
 * early, so there is nothing worth holding.
 */
test("pauseTarget offers nothing until the run has written the live.json that names it", () => {
  const owned: SlotView = { ...IDLE_SLOT, alive: true, pgid: CHILD_PID };
  assert.deepEqual(pauseTarget({ kind: "owned" }, owned, false, false), { kind: "none" });
  assert.deepEqual(pauseTarget({ kind: "owned" }, owned, false, true), {
    kind: "pause",
    owned: true,
    pid: CHILD_PID,
  });
});

test("pauseTarget reads owned true for its own child and false for a foreign run", () => {
  const owned: SlotView = { ...IDLE_SLOT, alive: true, pgid: CHILD_PID };
  assert.deepEqual(pauseTarget({ kind: "owned" }, owned, false, true), { kind: "pause", owned: true, pid: CHILD_PID });
  assert.deepEqual(pauseTarget({ kind: "foreign", pid: RUN_PID }, IDLE_SLOT, false, true), {
    kind: "pause",
    owned: false,
    pid: RUN_PID,
  });
});

test("a paused run stays reachable to stop even once its heartbeat goes stale, since freezing stops the beat", () => {
  const stale = snapshot("running", beat(40));
  assert.deepEqual(stopTarget(IDLE_SLOT, stale, NOW, runExists, true), { kind: "foreign", pid: RUN_PID });
  assert.deepEqual(stopTarget(IDLE_SLOT, stale, NOW, runExists, false), NOTHING);
});

test("calls a launch busy while a paused run holds the slug, and says paused rather than running", () => {
  const reason = busyReason(IDLE_SLOT, snapshot("running", beat(40)), NOW, true);
  assert.ok(reason?.includes("paused"));
});

/** A launcher whose frozen(...) always reads true, standing in for a run stopped by SIGSTOP. */
function frozenHarness() {
  const children: FakeChild[] = [];
  const launcher = createLauncher({
    start() {
      const child = fakeChild();
      children.push(child);
      return { ok: true, value: child.handle };
    },
    tail: () => "",
    exists: runExists,
    interrupt: () => ({ ok: true, value: undefined }),
    hold: () => ({ ok: true, value: undefined }),
    stopped: () => true,
  });
  return { launcher, children };
}

// A stopped process queues its SIGINT rather than acting on it, so the continue
// has to land first or the interrupt would never reach the cleanup handler —
// which is what stops a frozen run's sandboxes from leaking.
test("stops a frozen child of its own with a continue before the interrupt", () => {
  const { launcher, children } = frozenHarness();
  launcher.launch(REQUEST, null, NOW);

  assert.deepEqual(launcher.stop(null, NOW), { ok: true });
  assert.deepEqual(children[0]?.signals, ["SIGCONT", "SIGINT"]);
});

/** The launched child's own live.json: opened after the launch, so the slot owns it. */
function opened(): LiveSnapshot {
  const snap = snapshot("running", beat(1));
  return { ...snap, doc: { ...snap.doc, openedAt: new Date(Date.parse(NOW.toISOString()) + 1).toISOString() } };
}

test("hold refuses to pause a run that is already frozen, saying so", () => {
  const { launcher } = frozenHarness();
  launcher.launch(REQUEST, null, NOW);

  const outcome = launcher.hold("pause", opened(), NOW);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "idle");
  assert.ok(outcome.ok === false && outcome.message.includes("already paused"));
});

test("hold refuses to resume a run that is not frozen, saying so", () => {
  const { launcher } = harness();
  launcher.launch(REQUEST, null, NOW);

  const outcome = launcher.hold("resume", opened(), NOW);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "idle");
  assert.ok(outcome.ok === false && outcome.message.includes("not paused"));
});

test("hold offers nothing on a child that is still packing, which has no live.json to be found by", () => {
  const { launcher } = frozenHarness();
  launcher.launch(REQUEST, null, NOW);

  assert.deepEqual(launcher.holdTarget(null, NOW, false), { kind: "none" });
});

// ok means a signal was sent. A slot holding nothing has nothing to send one to,
// and has to say so rather than answer for a signal that never left.
test("pauses by the handle the slot holds, and holds nothing at all when it holds none", () => {
  const { launcher, children } = harness();
  launcher.launch(REQUEST, null, NOW);

  assert.deepEqual(launcher.hold("pause", opened(), NOW), { ok: true });
  assert.deepEqual(children[0]?.signals, ["SIGSTOP"]);

  const empty = harness().launcher;
  assert.deepEqual(empty.hold("pause", null, NOW), {
    ok: false,
    reason: "idle",
    message: "nothing to pause: no run is in flight",
  });
  assert.deepEqual(empty.hold("resume", null, NOW), {
    ok: false,
    reason: "idle",
    message: "nothing to resume: no run is paused",
  });
});

// A frozen process queues a SIGINT rather than acting on it, so the continue is
// what makes the interrupt land. One that failed leaves a run still frozen and
// still running, whatever the interrupt behind it reported.
test("fails a stop it could not continue first, rather than calling a frozen run stopped", () => {
  const launcher = createLauncher({
    start: () => ({ ok: false, error: "unused" }),
    tail: () => "",
    exists: runExists,
    interrupt: () => ({ ok: true, value: undefined }),
    hold: () => ({ ok: false, error: "kill ESRCH" }),
    stopped: () => true,
  });

  const stopped = launcher.stop(snapshot("running", beat(2)), NOW);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.ok === false && stopped.reason, "signal");
  assert.ok(stopped.ok === false && stopped.message.includes("kill ESRCH"));
});
