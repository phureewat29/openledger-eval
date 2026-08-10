import assert from "node:assert/strict";
import { test } from "node:test";
import { delay, sortBy } from "es-toolkit";
import type { ValidatedModel } from "../model/capabilities.js";
import { buildCounters } from "../report/counters.js";
import type { RunRecord } from "../report/record.js";
import { createRecorder } from "../report/recorder.js";
import type { SuiteId } from "../shared/vocabulary.js";
import { gradeOf, type AnySuite, type EvalCase } from "../suites/types.js";
import { expandPlan, runMatrix, type MatrixDeps, type PlannedRun } from "./matrix.js";

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

const INGEST = suite("ingest");

function cases(...ids: string[]): EvalCase[] {
  return ids.map((id) => ({ id, title: id }));
}

test("plans one run per model, case and trial", () => {
  const plan = expandPlan(
    [model("a/one"), model("b/two")],
    [INGEST],
    new Map([["ingest", cases("c1", "c2")] as [SuiteId, EvalCase[]]]),
    3,
  );
  assert.equal(plan.length, 2 * 2 * 3);
  assert.deepEqual(
    plan.filter((run) => run.model.id === "a/one" && run.kase.id === "c1").map((run) => run.trial),
    [1, 2, 3],
  );
});

test("interleaves plan cells round-robin across models", () => {
  const plan = expandPlan(
    [model("a/one"), model("b/two")],
    [INGEST],
    new Map([["ingest", cases("c1", "c2")] as [SuiteId, EvalCase[]]]),
    1,
  );
  assert.deepEqual(
    plan.map((run) => run.model.id),
    ["a/one", "b/two", "a/one", "b/two"],
  );
});

test("keeps each model's own case/trial order intact while interleaving across models", () => {
  const plan = expandPlan(
    [model("a/one"), model("b/two")],
    [INGEST],
    new Map([["ingest", cases("c1", "c2")] as [SuiteId, EvalCase[]]]),
    2,
  );
  assert.notEqual(plan[0]?.model.id, plan[1]?.model.id);
  assert.deepEqual(
    plan.filter((run) => run.model.id === "a/one").map((run) => `${run.kase.id}:${run.trial}`),
    ["c1:1", "c1:2", "c2:1", "c2:2"],
  );
});

test("plans nothing for a suite whose cases are missing", () => {
  assert.deepEqual(expandPlan([model("a/one")], [INGEST], new Map(), 1), []);
});

function planOf(...ids: string[]): PlannedRun[] {
  return expandPlan(
    [model("a/one")],
    [INGEST],
    new Map([["ingest", cases(...ids)] as [SuiteId, EvalCase[]]]),
    1,
  );
}

function graded(planned: PlannedRun): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: planned.model.id,
    suite: planned.suite.id,
    caseId: planned.kase.id,
    trial: planned.trial,
    state: "graded",
    error: null,
    grade: gradeOf(planned.kase.id, []),
    metrics: empty.metrics,
    counters: buildCounters(empty.events),
    questionsRaised: 0,
    costUsd: null,
    events: empty.events,
  };
}

/** The matrix returns nothing: onProgress is the only way out, and it fires in completion order. */
async function collect(
  plan: PlannedRun[],
  runOne: MatrixDeps["runOne"],
  concurrency: number,
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  const onProgress = (record: RunRecord): void => {
    records.push(record);
  };
  await runMatrix(plan, { runOne, onStart: () => {}, onProgress }, concurrency);
  return records;
}

/** runOne owns its own failures; if one ever escapes, the other cells must still be reported. */
test("turns a run that throws or rejects into a sandbox error, and keeps the rest", async () => {
  const records = await collect(
    planOf("throws", "rejects", "fine"),
    (planned) => {
      if (planned.kase.id === "throws") throw new Error("threw before the promise");
      if (planned.kase.id === "rejects") return Promise.reject(new Error("rejected"));
      return Promise.resolve(graded(planned));
    },
    2,
  );

  assert.deepEqual(
    sortBy(records, ["caseId"]).map((record) => [record.caseId, record.state, record.error]),
    [
      ["fine", "graded", null],
      ["rejects", "sandbox_error", "rejected"],
      ["throws", "sandbox_error", "threw before the promise"],
    ],
  );
  assert.ok(records.every((record) => record.grade === null || record.caseId === "fine"));
});

test("reports each run as it finishes, whatever its place in the plan", async () => {
  const finished: string[] = [];
  await runMatrix(
    planOf("slow", "quick", "quicker", "quickest"),
    {
      runOne: async (planned) => {
        await delay(planned.kase.id === "slow" ? 40 : 1);
        return graded(planned);
      },
      onStart: () => {},
      onProgress: (record) => finished.push(record.caseId),
    },
    4,
  );

  assert.equal(finished.length, 4, "every planned cell is reported once");
  assert.equal(finished[finished.length - 1], "slow", "the slow run should finish last");
});

/** onStart has to land before runOne is even called, not merely before onProgress: the live view marks a cell running while it is still in flight. */
test("starts every planned cell exactly once, each before its own run and its own finish", async () => {
  const events: string[] = [];
  await runMatrix(
    planOf("c1", "c2", "c3", "c4"),
    {
      runOne: async (planned) => {
        assert.ok(
          events.includes(`start:${planned.kase.id}`),
          `${planned.kase.id} must be started before it runs`,
        );
        await delay(planned.kase.id === "c1" ? 10 : 1);
        return graded(planned);
      },
      onStart: (planned) => events.push(`start:${planned.kase.id}`),
      onProgress: (record) => events.push(`finish:${record.caseId}`),
    },
    2,
  );

  assert.equal(events.filter((event) => event.startsWith("finish:")).length, 4);
  for (const id of ["c1", "c2", "c3", "c4"]) {
    assert.equal(events.filter((event) => event === `start:${id}`).length, 1, `${id} must start exactly once`);
    assert.ok(
      events.indexOf(`start:${id}`) < events.indexOf(`finish:${id}`),
      `${id} must start before it finishes`,
    );
  }
});

test("never runs more at once than the concurrency allows", async () => {
  let inFlight = 0;
  let peak = 0;
  const records = await collect(
    planOf("c1", "c2", "c3", "c4", "c5", "c6"),
    async (planned) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight -= 1;
      return graded(planned);
    },
    2,
  );

  assert.equal(records.length, 6);
  assert.equal(peak, 2);
});

test("runs a lone case without waiting on an idle pool", async () => {
  const records = await collect(planOf("only"), async (planned) => graded(planned), 8);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.state, "graded");
});
