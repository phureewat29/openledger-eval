import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseGrade } from "../suites/types.js";
import { buildBenchmark, type ConfigEcho } from "./benchmark.js";
import { buildCounters } from "./counters.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { createRecorder, type RunMetrics } from "./recorder.js";

const IDENTITY: RunIdentity = {
  startedAt: "2026-08-06T09:05:00.000Z",
  oledVersion: "1.2.3",
  tarballSha256: "a".repeat(64),
  skillVersion: "2.0.0",
  skillSha256: "b".repeat(64),
  evalVersion: "1.0.0",
};

function config(patch: Partial<ConfigEcho> = {}): ConfigEcho {
  return { suites: ["record", "query"], trials: 1, concurrency: 2, modelsRequested: [], ...patch };
}

function grade(passRate: number, passed: boolean): CaseGrade {
  return { caseId: "c1", assertions: [], passRate, passed };
}

function tokens(tokensIn: number, tokensOut: number): RunMetrics {
  const empty = createRecorder().snapshot().metrics;
  return { ...empty, tokensIn, tokensOut, durationMs: 1_000, toolCalls: 1 };
}

function record(patch: Partial<RunRecord> = {}): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: "anthropic/claude-sonnet-4.5",
    suite: "record",
    caseId: "c1",
    trial: 1,
    state: "graded",
    error: null,
    grade: grade(1, true),
    metrics: empty.metrics,
    counters: buildCounters(empty.events),
    questionsRaised: 0,
    costUsd: 0.01,
    events: empty.events,
    ...patch,
  };
}

test("means and sample-stddevs pass rate over graded trials", () => {
  const records = [1, 0.5, 0.75].map((passRate, index) =>
    record({ trial: index + 1, grade: grade(passRate, passRate === 1) }),
  );
  const [entry] = buildBenchmark(records, IDENTITY, config({ trials: 3 }), []).entries;
  assert.ok(entry);
  assert.equal(entry.meanPassRate, 0.75);
  assert.ok(entry.stddevPassRate !== null);
  assert.ok(Math.abs(entry.stddevPassRate - 0.25) < 1e-9, `expected stddev 0.25, got ${entry.stddevPassRate}`);
});

test("leaves stddev null under two graded runs", () => {
  const [entry] = buildBenchmark([record()], IDENTITY, config(), []).entries;
  assert.ok(entry);
  assert.equal(entry.stddevPassRate, null);
});

test("passes a case only when every graded trial of it passed", () => {
  const records = [
    record({ caseId: "flaky", trial: 1, grade: grade(1, true) }),
    record({ caseId: "flaky", trial: 2, grade: grade(0.5, false) }),
    record({ caseId: "solid", trial: 1, grade: grade(1, true) }),
    record({ caseId: "solid", trial: 2, grade: grade(1, true) }),
  ];
  const [entry] = buildBenchmark(records, IDENTITY, config({ trials: 2 }), []).entries;
  assert.ok(entry);
  assert.deepEqual(entry.cases, { passed: 1, total: 2 });
});

test("prices an entry only when every graded run priced", () => {
  const priced = [record({ caseId: "a", costUsd: 0.01 }), record({ caseId: "b", costUsd: 0.02 })];
  const [pricedEntry] = buildBenchmark(priced, IDENTITY, config(), []).entries;
  assert.ok(pricedEntry);
  assert.ok(pricedEntry.totalCostUsd !== null);
  assert.ok(Math.abs(pricedEntry.totalCostUsd - 0.03) < 1e-9);

  const partial = [record({ caseId: "a", costUsd: 0.01 }), record({ caseId: "b", costUsd: null })];
  const [partialEntry] = buildBenchmark(partial, IDENTITY, config(), []).entries;
  assert.ok(partialEntry);
  assert.equal(partialEntry.totalCostUsd, null);
});

test("tallies terminal states within one entry", () => {
  const records = [
    record({ caseId: "a", state: "graded", grade: grade(1, true) }),
    record({ caseId: "b", state: "endpoint_error", grade: null, error: "timed out" }),
    record({ caseId: "c", state: "sandbox_error", grade: null, error: "install failed" }),
    record({ caseId: "d", state: "sandbox_error", grade: null, error: "install failed" }),
  ];
  const [entry] = buildBenchmark(records, IDENTITY, config(), []).entries;
  assert.ok(entry);
  assert.deepEqual(entry.terminal, { graded: 1, endpoint_error: 1, sandbox_error: 2 });
});

test("an entry with nothing graded reads as zero, not NaN or a missing case", () => {
  const records = [
    record({ caseId: "a", state: "endpoint_error", grade: null, error: "boom" }),
    record({ caseId: "a", trial: 2, state: "endpoint_error", grade: null, error: "boom" }),
  ];
  const [entry] = buildBenchmark(records, IDENTITY, config({ trials: 2 }), []).entries;
  assert.ok(entry);
  assert.equal(entry.meanPassRate, 0);
  assert.equal(entry.stddevPassRate, null);
  assert.deepEqual(entry.cases, { passed: 0, total: 1 });
  assert.equal(entry.avgDurationMs, 0);
  assert.deepEqual(entry.avgTokens, { in: 0, out: 0 });
  assert.equal(entry.avgToolCalls, 0);
  // Vacuously true over zero graded runs, same as an empty sum: see the M4 report for this call.
  assert.equal(entry.totalCostUsd, 0);
});

test("orders entries by suite, then pass rate desc, then tokens asc, then model asc", () => {
  const records: RunRecord[] = [
    record({ model: "b/model", suite: "record", caseId: "c1", grade: grade(0.5, false), metrics: tokens(10, 10) }),
    record({ model: "a/model", suite: "record", caseId: "c1", grade: grade(0.9, true), metrics: tokens(10, 10) }),
    record({ model: "d/model", suite: "record", caseId: "c1", grade: grade(0.7, false), metrics: tokens(80, 20) }),
    record({ model: "c/model", suite: "record", caseId: "c1", grade: grade(0.7, false), metrics: tokens(30, 20) }),
    record({ model: "z/model", suite: "query", caseId: "q1", grade: grade(0.99, true), metrics: tokens(5, 5) }),
  ];
  const benchmark = buildBenchmark(records, IDENTITY, config({ suites: ["record", "query"] }), []);
  assert.deepEqual(
    benchmark.entries.map((entry) => entry.model),
    ["a/model", "c/model", "d/model", "b/model", "z/model"],
  );
});

test("breaks a full tie on model id, ascending", () => {
  const records = [
    record({ model: "zeta/model", caseId: "c1", grade: grade(0.6, false), metrics: tokens(10, 10) }),
    record({ model: "alpha/model", caseId: "c1", grade: grade(0.6, false), metrics: tokens(10, 10) }),
  ];
  const benchmark = buildBenchmark(records, IDENTITY, config(), []);
  assert.deepEqual(
    benchmark.entries.map((entry) => entry.model),
    ["alpha/model", "zeta/model"],
  );
});

test("carries the schema version, identity and skipped models through untouched", () => {
  const skipped = [{ id: "vendor/nope", reason: "no tool calling" }];
  const benchmark = buildBenchmark([], IDENTITY, config(), skipped);
  assert.equal(benchmark.schemaVersion, 1);
  assert.deepEqual(benchmark.identity, IDENTITY);
  assert.deepEqual(benchmark.skippedModels, skipped);
  assert.deepEqual(benchmark.entries, []);
});
