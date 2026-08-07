import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { buildCounters } from "./counters.js";
import type { RunRecord } from "./record.js";
import { createRecorder } from "./recorder.js";
import { createReportDir, timestampSlug, writeRunFiles } from "./write.js";

function record(patch: Partial<RunRecord> = {}): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: "anthropic/claude-sonnet-4.5",
    suite: "record",
    caseId: "card-statement-2026-05",
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
  return mkdtempSync(join(tmpdir(), "oled-eval-write-"));
}

test("names a report directory by the minute it started, zero-padded", () => {
  assert.equal(timestampSlug(new Date(2026, 7, 6, 9, 5)), "2026-08-06-0905");
  assert.equal(timestampSlug(new Date(2026, 11, 31, 23, 59)), "2026-12-31-2359");
});

test("creates the report directory under the reports root", () => {
  const root = scratch();
  try {
    const dir = createReportDir(root, new Date(2026, 7, 6, 9, 5));
    assert.ok(dir.ok);
    assert.equal(dir.value, join(root, "2026-08-06-0905"));
    assert.ok(existsSync(dir.value));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files one run per model, suite and case, and writes the record back whole", () => {
  const root = scratch();
  try {
    const written = writeRunFiles(root, record(), 1);
    assert.ok(written.ok);
    assert.equal(
      relative(root, written.value),
      join("runs", "anthropic-claude-sonnet-4-5", "record", "card-statement-2026-05.json"),
    );
    assert.deepEqual(JSON.parse(readFileSync(written.value, "utf8")), record());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("numbers a file only once the case was run more than once", () => {
  const root = scratch();
  try {
    const single = writeRunFiles(root, record({ trial: 1 }), 1);
    const repeated = writeRunFiles(root, record({ trial: 2 }), 3);
    assert.ok(single.ok);
    assert.ok(repeated.ok);
    assert.match(single.value, /card-statement-2026-05\.json$/);
    assert.match(repeated.value, /card-statement-2026-05-t2\.json$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The record is the only file a run leaves. A rendered markdown copy used to sit
// beside it, carrying nothing the json did not already hold and committed by
// nothing, so it was dropped rather than kept in step.
test("writes the record and nothing beside it", () => {
  const root = scratch();
  try {
    const written = writeRunFiles(root, record(), 1);
    assert.ok(written.ok);
    assert.ok(written.value.endsWith(".json"));
    assert.equal(existsSync(written.value.replace(/\.json$/, ".md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
