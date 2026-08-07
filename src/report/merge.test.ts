import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCounters } from "./counters.js";
import { identityDrift, mergeEcho, mergeRecords } from "./merge.js";
import type { ConfigEcho } from "./benchmark.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { createRecorder } from "./recorder.js";

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

function echo(patch: Partial<ConfigEcho> = {}): ConfigEcho {
  return { suites: ["record"], trials: 1, concurrency: 2, modelsRequested: ["a/one"], ...patch };
}

function identity(patch: Partial<RunIdentity> = {}): RunIdentity {
  return {
    startedAt: "2026-08-06T09:05:00.000Z",
    oledVersion: "1.2.3",
    tarballSha256: "a".repeat(64),
    skillVersion: "2.0.0",
    skillSha256: "b".repeat(64),
    evalVersion: "1.0.0",
    ...patch,
  };
}

test("mergeRecords replaces the prior record for the same cell and leaves every other cell untouched", () => {
  const prior = [record({ model: "a/one", caseId: "c1", state: "graded" }), record({ model: "b/two", caseId: "c1" })];
  const fresh = [record({ model: "a/one", caseId: "c1", state: "sandbox_error" })];

  const merged = mergeRecords(prior, fresh);

  assert.equal(merged.length, 2);
  const aOne = merged.find((r) => r.model === "a/one");
  const bTwo = merged.find((r) => r.model === "b/two");
  assert.equal(aOne?.state, "sandbox_error", "the fresh record supersedes the prior one for its own cell");
  assert.equal(bTwo, prior[1], "an untouched cell is the same record, not a rebuilt copy");
});

test("mergeRecords appends a fresh record for a cell the prior report never held", () => {
  const prior = [record({ model: "a/one", caseId: "c1" })];
  const fresh = [record({ model: "a/one", caseId: "c2" })];

  const merged = mergeRecords(prior, fresh);

  assert.deepEqual(
    merged.map((r) => r.caseId).toSorted(),
    ["c1", "c2"],
  );
});

test("mergeRecords tells cells apart by model, suite, caseId and trial together", () => {
  const prior = [record({ model: "a/one", suite: "record", caseId: "c1", trial: 1 })];
  const fresh = [record({ model: "a/one", suite: "query", caseId: "c1", trial: 1, state: "endpoint_error" })];

  const merged = mergeRecords(prior, fresh);

  assert.equal(merged.length, 2, "a different suite is a different cell, even with the same model and caseId");
});

test("mergeEcho unions suites and modelsRequested with the prior report's order first", () => {
  const prior = echo({ suites: ["record", "query"], modelsRequested: ["a/one", "b/two"] });
  const next = echo({ suites: ["query", "ingest"], modelsRequested: ["b/two", "c/three"] });

  const merged = mergeEcho(prior, next);

  assert.deepEqual(merged.suites, ["record", "query", "ingest"]);
  assert.deepEqual(merged.modelsRequested, ["a/one", "b/two", "c/three"]);
});

test("mergeEcho keeps the prior report's trials and takes concurrency from the new invocation", () => {
  const prior = echo({ trials: 1, concurrency: 4 });
  const next = echo({ trials: 1, concurrency: 8 });

  const merged = mergeEcho(prior, next);

  assert.equal(merged.trials, prior.trials);
  assert.equal(merged.concurrency, 8);
});

test("identityDrift is null when both pinned hashes still match", () => {
  const pinned = identity();
  const current = identity();
  assert.equal(identityDrift(pinned, current), null);
});

test("identityDrift names oled when only the tarball hash moved", () => {
  const pinned = identity();
  const current = identity({ tarballSha256: "c".repeat(64) });
  const message = identityDrift(pinned, current);
  assert.ok(message?.includes("oled"));
  assert.ok(!message?.includes("SKILL.md"));
});

test("identityDrift names SKILL.md when only the skill hash moved", () => {
  const pinned = identity();
  const current = identity({ skillSha256: "c".repeat(64) });
  const message = identityDrift(pinned, current);
  assert.ok(message?.includes("SKILL.md"));
  assert.ok(!message?.includes("oled"));
});

test("identityDrift names both when both hashes moved", () => {
  const pinned = identity();
  const current = identity({ tarballSha256: "c".repeat(64), skillSha256: "d".repeat(64) });
  const message = identityDrift(pinned, current);
  assert.ok(message?.includes("oled"));
  assert.ok(message?.includes("SKILL.md"));
});
