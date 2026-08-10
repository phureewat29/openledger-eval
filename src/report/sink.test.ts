import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ValidatedModel } from "../model/capabilities.js";
import { runMatrix, type PlannedRun } from "../runner/matrix.js";
import type { SuiteId } from "../shared/vocabulary.js";
import { gradeOf, type AnySuite } from "../suites/types.js";
import type { Benchmark, ConfigEcho } from "./benchmark.js";
import { buildCounters } from "./counters.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { createRecorder } from "./recorder.js";
import { createReportSink } from "./sink.js";

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

function record(patch: Partial<RunRecord> = {}): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: "a/one",
    suite: "record",
    caseId: "c1",
    trial: 1,
    state: "graded",
    error: null,
    grade: gradeOf("c1", []),
    metrics: empty.metrics,
    counters: buildCounters(empty.events),
    questionsRaised: 0,
    costUsd: null,
    events: empty.events,
    ...patch,
  };
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

function planned(modelId: string, caseId: string): PlannedRun {
  return { model: model(modelId), suite: suite("record"), kase: { id: caseId }, trial: 1 };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "oled-eval-sink-"));
}

function sinkAt(dir: string, patch: Partial<ConfigEcho> = {}) {
  return createReportSink(dir, IDENTITY, config(patch), []);
}

function readBenchmark(dir: string): Benchmark {
  return JSON.parse(readFileSync(join(dir, "benchmark.json"), "utf8")) as Benchmark;
}

/** A file where a run's directory has to go: every write under it fails, and nothing else does. */
function blockRunDir(dir: string, modelSlug: string, suiteId: SuiteId): void {
  mkdirSync(join(dir, "runs", modelSlug), { recursive: true });
  writeFileSync(join(dir, "runs", modelSlug, suiteId), "");
}

test("files a run's record the moment it is added", () => {
  const dir = scratch();
  try {
    const sink = sinkAt(dir);
    sink.add(record({ model: "a/one", caseId: "c1" }));

    const stem = join(dir, "runs", "a-one", "record", "c1");
    assert.ok(existsSync(`${stem}.json`), "the run json lands before the matrix ends");
    assert.ok(!existsSync(join(dir, "benchmark.json")), "the benchmark waits for the close");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run whose files cannot be written warns once and does not stop the matrix", async (t) => {
  const stderr = t.mock.method(process.stderr, "write", (): boolean => true);
  const dir = scratch();
  try {
    blockRunDir(dir, "a-one", "record");
    const sink = sinkAt(dir);
    const plan = [planned("a/one", "c1"), planned("b/two", "c1"), planned("a/one", "c2"), planned("b/two", "c2")];

    await runMatrix(
      plan,
      {
        runOne: async (run) => record({ model: run.model.id, caseId: run.kase.id }),
        onStart: () => undefined,
        onProgress: (finished) => sink.add(finished),
      },
      2,
    );

    assert.equal(sink.records().length, 4, "every planned run still ran");
    assert.equal(stderr.mock.callCount(), 1, "one warning, then silence");
    assert.match(String(stderr.mock.calls[0]?.arguments[0]), /cannot write .*c\d\.json/);
    assert.ok(existsSync(join(dir, "runs", "b-two", "record", "c1.json")), "the writable runs are unaffected");

    const closed = sink.close();
    assert.ok(closed.ok);
    const entries = readBenchmark(dir).entries;
    assert.deepEqual(
      entries.map((entry) => [entry.model, entry.terminal.graded]),
      [
        ["a/one", 2],
        ["b/two", 2],
      ],
      "a run with no file on disk is still counted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interrupt writes the benchmark and leaderboard from the runs that finished", () => {
  const dir = scratch();
  try {
    const sink = sinkAt(dir);
    sink.add(record({ caseId: "c1" }));
    sink.add(record({ caseId: "c2", state: "endpoint_error", grade: null, error: "502" }));

    sink.closeOnExit();

    const [entry] = readBenchmark(dir).entries;
    assert.ok(entry);
    assert.deepEqual(entry.terminal, { graded: 1, endpoint_error: 1, sandbox_error: 0 });
    assert.equal(entry.cases.total, 2, "the two cases that finished, not the whole plan");
    assert.match(readFileSync(join(dir, "leaderboard.md"), "utf8"), /^# openledger eval/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean close writes the benchmark once, and the exit handler leaves it alone", () => {
  const dir = scratch();
  try {
    const sink = sinkAt(dir);
    sink.add(record());

    const closed = sink.close();
    assert.ok(closed.ok);
    assert.match(closed.value, /^# openledger eval/, "the close returns the leaderboard to print");

    writeFileSync(join(dir, "benchmark.json"), "sentinel");
    sink.closeOnExit();
    assert.equal(readFileSync(join(dir, "benchmark.json"), "utf8"), "sentinel", "no second benchmark write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interrupt before the first run finishes leaves an empty report, not a crash", () => {
  const dir = scratch();
  try {
    sinkAt(dir).closeOnExit();

    const benchmark = readBenchmark(dir);
    assert.deepEqual(benchmark.entries, []);
    assert.equal(benchmark.identity.oledVersion, "1.2.3");
    assert.ok(existsSync(join(dir, "leaderboard.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps the finished records for the caller that reports the outcome", () => {
  const dir = scratch();
  try {
    const sink = sinkAt(dir);
    sink.add(record({ caseId: "c1" }));
    sink.add(record({ caseId: "c2" }));

    assert.deepEqual(
      sink.records().map((finished) => finished.caseId),
      ["c1", "c2"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
