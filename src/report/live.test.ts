import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { ValidatedModel } from "../model/capabilities.js";
import type { PlannedRun } from "../runner/matrix.js";
import type { SuiteId } from "../shared/vocabulary.js";
import { gradeOf, notApplicable, type AnySuite, type AssertionResult } from "../suites/types.js";
import type { ConfigEcho } from "./benchmark.js";
import { buildCounters } from "./counters.js";
import {
  buildLiveDoc,
  createLiveWriter,
  finalizeDoc,
  markFinished,
  markRunning,
  reopenLiveDoc,
  writeLive,
  type LiveDoc,
} from "./live.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { createRecorder } from "./recorder.js";

/** Mirrors live.ts's own HEARTBEAT_MS; not imported since the module keeps it private. */
const HEARTBEAT_INTERVAL_MS = 5_000;

const IDENTITY: RunIdentity = {
  startedAt: "2026-08-06T09:05:00.000Z",
  oledVersion: "1.2.3",
  suiteSha256: "a".repeat(64),
  skillVersion: "2.0.0",
  skillSha256: "b".repeat(64),
  evalVersion: "1.0.0",
};

function config(patch: Partial<ConfigEcho> = {}): ConfigEcho {
  return { suites: ["record", "query"], trials: 1, concurrency: 2, modelsRequested: [], ...patch };
}

function model(id: string): ValidatedModel {
  return { id, modalities: ["text"], contextLength: 128_000, pricing: null };
}

function suite(id: SuiteId): AnySuite {
  return {
    id,
    cases: () => ({ ok: true, value: [] }),
    prepare: async () => ({ ok: true, value: [] }),
    systemPrompt: () => "",
    tools: () => [],
    score: ({ kase }) => gradeOf(kase.id, []),
  };
}

function planned(modelId: string, suiteId: SuiteId, caseId: string, trial = 1): PlannedRun {
  return { model: model(modelId), suite: suite(suiteId), kase: { id: caseId }, trial };
}

function record(patch: Partial<RunRecord> = {}): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: "a/one",
    suite: "record",
    caseId: "c1",
    trial: 1,
    state: "graded",
    error: null,
    grade: null,
    metrics: empty.metrics,
    counters: buildCounters(empty.events),
    questionsRaised: 0,
    costUsd: null,
    events: empty.events,
    ...patch,
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "oled-eval-live-"));
}

function readLive(dir: string): LiveDoc {
  return JSON.parse(readFileSync(join(dir, "live.json"), "utf8")) as LiveDoc;
}

test("buildLiveDoc plans every item pending, in plan order", () => {
  const plan = [planned("a/one", "record", "c1"), planned("a/one", "record", "c2"), planned("b/two", "record", "c1")];
  const doc = buildLiveDoc(IDENTITY, config(), plan, new Date("2026-08-06T09:05:00.000Z"));

  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.status, "running");
  assert.equal(doc.startedAt, "2026-08-06T09:05:00.000Z");
  assert.equal(doc.updatedAt, "2026-08-06T09:05:00.000Z");
  assert.deepEqual(
    doc.items.map((item) => [item.model, item.suite, item.caseId, item.trial, item.state]),
    [
      ["a/one", "record", "c1", 1, "pending"],
      ["a/one", "record", "c2", 1, "pending"],
      ["b/two", "record", "c1", 1, "pending"],
    ],
  );
  assert.ok(doc.items.every((item) => item.passRate === null && item.durationMs === null));
});

test("markRunning updates only the addressed quad and leaves the doc it was given untouched", () => {
  const plan = [planned("a/one", "record", "c1", 1), planned("a/one", "record", "c1", 2)];
  const doc = buildLiveDoc(IDENTITY, config(), plan, new Date());

  const next = markRunning(doc, plan[1] as PlannedRun);

  assert.equal(doc.items[1]?.state, "pending", "the doc passed in must not mutate");
  assert.equal(next.items[0]?.state, "pending", "trial 1 is a different quad and must stay untouched");
  assert.equal(next.items[1]?.state, "running");
});

test("markFinished reads state, passRate and durationMs off the RunRecord, addressed by quad", () => {
  const plan = [planned("a/one", "record", "c1"), planned("b/two", "record", "c1")];
  const doc = markRunning(buildLiveDoc(IDENTITY, config(), plan, new Date()), plan[0] as PlannedRun);
  const grade = gradeOf("c1", []);
  const finished = record({
    model: "a/one",
    suite: "record",
    caseId: "c1",
    trial: 1,
    state: "graded",
    grade,
    metrics: { ...createRecorder().snapshot().metrics, durationMs: 4_200 },
  });

  const next = markFinished(doc, finished);

  assert.equal(doc.items[0]?.state, "running", "the doc passed in must not mutate");
  assert.deepEqual(
    [next.items[0]?.state, next.items[0]?.passRate, next.items[0]?.durationMs],
    ["graded", grade.passRate, 4_200],
  );
  assert.equal(next.items[1]?.state, "pending", "a different model at the same caseId must stay untouched");
});

test("markFinished counts the checks a grade passed, and omits them when there is no grade", () => {
  const plan = [planned("a/one", "record", "c1"), planned("b/two", "record", "c1")];
  const doc = buildLiveDoc(IDENTITY, config(), plan, new Date());
  const assertions: AssertionResult[] = [
    { id: "one", label: "one", passed: true, evidence: { want: "1", got: "1" } },
    { id: "two", label: "two", passed: false, evidence: { want: "2", got: "3" } },
    notApplicable("three", "three", "the case carried no statement"),
  ];

  const graded = markFinished(doc, record({ model: "a/one", caseId: "c1", grade: gradeOf("c1", assertions) }));
  assert.deepEqual(
    [graded.items[0]?.checksPassed, graded.items[0]?.checksTotal],
    [1, 2],
    "the n/a assertion counts in neither half",
  );
  assert.equal(graded.items[1]?.checksTotal, undefined, "an untouched item stays as it was planned");

  const failed = markFinished(doc, record({ model: "b/two", caseId: "c1", state: "sandbox_error", grade: null }));
  assert.deepEqual(
    [failed.items[1]?.checksPassed, failed.items[1]?.checksTotal],
    [undefined, undefined],
    "nothing was checked, and 0/0 would read as a score",
  );
});

test("markFinished leaves passRate null for a terminal state that carries no grade", () => {
  const plan = [planned("a/one", "record", "c1")];
  const doc = buildLiveDoc(IDENTITY, config(), plan, new Date());
  const finished = record({
    model: "a/one",
    suite: "record",
    caseId: "c1",
    trial: 1,
    state: "endpoint_error",
    grade: null,
  });

  const next = markFinished(doc, finished);

  assert.equal(next.items[0]?.state, "endpoint_error");
  assert.equal(next.items[0]?.passRate, null);
});

test("finalizeDoc marks the run done without touching its items", () => {
  const plan = [planned("a/one", "record", "c1")];
  const doc = markRunning(buildLiveDoc(IDENTITY, config(), plan, new Date()), plan[0] as PlannedRun);

  const next = finalizeDoc(doc);

  assert.equal(doc.status, "running", "the doc passed in must not mutate");
  assert.equal(next.status, "done");
  assert.deepEqual(next.items, doc.items);
});

test("reopenLiveDoc takes a plan cell back to pending, clearing its passRate and durationMs", () => {
  const prior = [
    record({
      model: "a/one",
      suite: "record",
      caseId: "c1",
      grade: gradeOf("c1", []),
      metrics: { ...createRecorder().snapshot().metrics, durationMs: 4_200 },
    }),
  ];
  const plan = [planned("a/one", "record", "c1")];

  const doc = reopenLiveDoc(IDENTITY, config(), prior, plan, "2026-08-06T09:00:00.000Z", new Date("2026-08-06T09:10:00.000Z"));

  const item = doc.items.find((entry) => entry.model === "a/one" && entry.caseId === "c1");
  assert.equal(item?.state, "pending");
  assert.equal(item?.passRate, null);
  assert.equal(item?.durationMs, null);
});

test("reopenLiveDoc keeps a prior record's terminal state, passRate and check counts when the plan will not run it again", () => {
  const grade = gradeOf("c1", [{ id: "a", label: "a", passed: true, evidence: { want: "1", got: "1" } }]);
  const prior = [
    record({
      model: "b/two",
      suite: "record",
      caseId: "c1",
      grade,
      metrics: { ...createRecorder().snapshot().metrics, durationMs: 1_000 },
    }),
  ];

  const doc = reopenLiveDoc(IDENTITY, config(), prior, [], "2026-08-06T09:00:00.000Z", new Date());

  const item = doc.items.find((entry) => entry.model === "b/two" && entry.caseId === "c1");
  assert.equal(item?.state, "graded", "a cell the plan will not touch again keeps its terminal state");
  assert.equal(item?.passRate, grade.passRate);
  assert.equal(item?.checksPassed, 1);
  assert.equal(item?.checksTotal, 1);
});

// withItem is a no-op for a key it cannot find, so a case new to the report
// would run to completion without the grid ever drawing it unless this appends it.
test("reopenLiveDoc appends a plan cell the prior report never held", () => {
  const prior = [record({ model: "a/one", suite: "record", caseId: "c1" })];
  const plan = [planned("a/one", "record", "c1"), planned("a/one", "record", "c2")];

  const doc = reopenLiveDoc(IDENTITY, config(), prior, plan, "2026-08-06T09:00:00.000Z", new Date());

  const item = doc.items.find((entry) => entry.caseId === "c2");
  assert.ok(item !== undefined, "a case missing from items would never render");
  assert.equal(item?.state, "pending");
});

test("reopenLiveDoc carries the startedAt it was given rather than now, and status is running", () => {
  const doc = reopenLiveDoc(IDENTITY, config(), [], [], "2026-08-06T09:00:00.000Z", new Date("2026-08-06T09:10:00.000Z"));
  assert.equal(doc.startedAt, "2026-08-06T09:00:00.000Z");
  assert.equal(doc.status, "running");
});

/**
 * The iteration began then; this runner took it up now. A dashboard tells its
 * own child's document from an older one by the second of those, so collapsing
 * the two leaves a rerun reading as "starting" for as long as it runs.
 */
test("reopenLiveDoc opens at now even though the iteration started earlier", () => {
  const doc = reopenLiveDoc(IDENTITY, config(), [], [], "2026-08-06T09:00:00.000Z", new Date("2026-08-06T09:10:00.000Z"));
  assert.equal(doc.openedAt, "2026-08-06T09:10:00.000Z");
});

test("buildLiveDoc opens when it starts, the two being the same moment for a fresh run", () => {
  const doc = buildLiveDoc(IDENTITY, config(), [], new Date("2026-08-06T09:10:00.000Z"));
  assert.equal(doc.openedAt, doc.startedAt);
});

/**
 * The pid is what lets anything but the process that spawned the run stop it,
 * so it has to survive every transition and reach the file a reader opens.
 */
test("stamps the runner's own pid and carries it through to the finished file", () => {
  const dir = scratch();
  try {
    const plan = [planned("a/one", "record", "c1")];
    const doc = buildLiveDoc(IDENTITY, config(), plan, new Date());
    assert.equal(doc.pid, process.pid);

    const running = markRunning(doc, plan[0] as PlannedRun);
    const finished = finalizeDoc(markFinished(running, record({ model: "a/one", suite: "record", caseId: "c1" })));
    assert.equal(finished.pid, process.pid);

    assert.ok(writeLive(dir, finished).ok);
    assert.equal(readLive(dir).pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeLive leaves valid JSON on disk and no leftover tmp file", () => {
  const dir = scratch();
  try {
    const plan = [planned("a/one", "record", "c1")];
    const doc = buildLiveDoc(IDENTITY, config(), plan, new Date("2026-08-06T09:05:00.000Z"));

    const written = writeLive(dir, doc);

    assert.ok(written.ok);
    assert.deepEqual(readLive(dir), doc);
    assert.equal(existsSync(join(dir, "live.json.tmp")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLiveWriter writes start and finish through to disk, addressed by quad", () => {
  const dir = scratch();
  const plan = [planned("a/one", "record", "c1"), planned("b/two", "record", "c1")];
  const writer = createLiveWriter(dir, buildLiveDoc(IDENTITY, config(), plan, new Date()));
  try {
    writer.start(plan[0] as PlannedRun);
    assert.equal(readLive(dir).items[0]?.state, "running");
    assert.equal(readLive(dir).items[1]?.state, "pending");

    writer.finish(record({ model: "a/one", suite: "record", caseId: "c1", trial: 1, grade: gradeOf("c1", []) }));
    const afterFinish = readLive(dir);
    assert.equal(afterFinish.items[0]?.state, "graded");
    assert.equal(afterFinish.items[1]?.state, "pending");
  } finally {
    writer.finalize();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLiveWriter heartbeats a fresh updatedAt every 5s and stops once finalized", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const dir = scratch();
  const plan = [planned("a/one", "record", "c1")];
  const writer = createLiveWriter(dir, buildLiveDoc(IDENTITY, config(), plan, new Date()));
  try {
    const afterCreate = readLive(dir).updatedAt;

    mock.timers.tick(HEARTBEAT_INTERVAL_MS);
    const afterOneBeat = readLive(dir).updatedAt;
    assert.notEqual(afterOneBeat, afterCreate, "the 5s heartbeat should have rewritten updatedAt");

    mock.timers.tick(HEARTBEAT_INTERVAL_MS);
    const afterTwoBeats = readLive(dir).updatedAt;
    assert.notEqual(afterTwoBeats, afterOneBeat, "a second heartbeat should rewrite updatedAt again");

    writer.finalize();
    const afterFinalize = readLive(dir);
    assert.equal(afterFinalize.status, "done");

    mock.timers.tick(HEARTBEAT_INTERVAL_MS * 4);
    assert.deepEqual(readLive(dir), afterFinalize, "no further heartbeat writes once finalized");
  } finally {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
