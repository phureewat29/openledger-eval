import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  findIteration,
  listIterations,
  listRunFiles,
  listRunRecords,
  newestLive,
  readBenchmark,
  readFeedTail,
  readLive,
  readRunRecord,
} from "./reports-fs.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "oled-eval-dashboard-"));
}

function put(root: string, relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function benchmarkJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, entries: [], skippedModels: [], ...patch });
}

function liveJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, status: "running", items: [], ...patch });
}

/** A reports tree with two finished iterations, one still running, and the archive beside them. */
function fixture(): string {
  const root = scratch();
  put(root, "2026-08-05-0900/benchmark.json", benchmarkJson({ startedAt: "old" }));
  put(root, "2026-08-06-1000/benchmark.json", benchmarkJson({ startedAt: "mid" }));
  put(root, "2026-08-06-1000/live.json", liveJson({ status: "done" }));
  put(root, "2026-08-07-1144/live.json", liveJson({ startedAt: "new" }));
  put(root, "archive/2026-07-29-0058-a-model.json", "{}");
  put(root, "notes.md", "loose file");
  return root;
}

test("lists only dated directories, newest first, flagging what each holds", () => {
  const root = fixture();
  try {
    const iterations = listIterations(root);
    assert.ok(iterations.ok);
    assert.deepEqual(iterations.value, [
      { slug: "2026-08-07-1144", hasBenchmark: false, hasLive: true },
      { slug: "2026-08-06-1000", hasBenchmark: true, hasLive: true },
      { slug: "2026-08-05-0900", hasBenchmark: true, hasLive: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats a missing reports directory as no iterations at all", () => {
  const root = scratch();
  try {
    const iterations = listIterations(join(root, "never-created"));
    assert.deepEqual(iterations, { ok: true, value: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds one iteration by slug and nothing for a name that is not one", () => {
  const root = fixture();
  try {
    const found = findIteration(root, "2026-08-06-1000");
    assert.ok(found.ok);
    assert.equal(found.value?.hasBenchmark, true);

    for (const name of ["archive", "notes.md", "2026-08-06-100", "nope"]) {
      const missing = findIteration(root, name);
      assert.ok(missing.ok);
      assert.equal(missing.value, null, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads a v1 document and keeps fields this build never heard of", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/benchmark.json", benchmarkJson({ entries: [{ model: "a", noSkill: true }] }));
    const benchmark = readBenchmark(root, "2026-08-06-1000");
    assert.ok(benchmark.ok);
    assert.deepEqual(benchmark.value.entries[0], { model: "a", noSkill: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a document that is missing, unparseable, or not schemaVersion 1", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/benchmark.json", "{not json");
    put(root, "2026-08-06-1001/benchmark.json", benchmarkJson({ schemaVersion: 2 }));
    put(root, "2026-08-06-1002/benchmark.json", "null");

    assert.equal(readBenchmark(root, "2026-08-06-1000").ok, false);
    assert.equal(readBenchmark(root, "2026-08-06-1001").ok, false);
    assert.equal(readBenchmark(root, "2026-08-06-1002").ok, false);
    assert.equal(readBenchmark(root, "2026-08-06-9999").ok, false);
    assert.equal(readBenchmark(root, "../etc").ok, false);
    assert.equal(readLive(root, "archive").ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("takes the newest live.json there is, and null when there is none", () => {
  const root = fixture();
  try {
    const newest = newestLive(root);
    assert.ok(newest.ok);
    assert.equal(newest.value?.slug, "2026-08-07-1144");
    assert.equal(newest.value?.doc.status, "running");

    const empty = scratch();
    try {
      put(empty, "2026-08-06-1000/benchmark.json", benchmarkJson());
      assert.deepEqual(newestLive(empty), { ok: true, value: null });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function feedLine(text: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { at: "2026-08-07T05:00:00.000Z", scope: "a-model q01", kind: "tool", text, ...patch };
}

function feedNdjson(lines: Record<string, unknown>[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

test("reads a feed oldest first, keeping only the last lines asked for", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/feed.ndjson", feedNdjson([feedLine("one"), feedLine("two"), feedLine("three")]));

    const tail = readFeedTail(root, "2026-08-06-1000", 2);
    assert.ok(tail.ok);
    assert.deepEqual(
      tail.value.map((line) => line.text),
      ["two", "three"],
    );
    assert.deepEqual(tail.value[0], {
      at: "2026-08-07T05:00:00.000Z",
      scope: "a-model q01",
      kind: "tool",
      text: "two",
    });

    const all = readFeedTail(root, "2026-08-06-1000", 100);
    assert.ok(all.ok);
    assert.equal(all.value.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats a feed that was never written as an empty one, and refuses a name that is not an iteration", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/live.json", liveJson());
    assert.deepEqual(readFeedTail(root, "2026-08-06-1000", 10), { ok: true, value: [] });
    assert.deepEqual(readFeedTail(root, "2026-08-06-9999", 10), { ok: true, value: [] });

    for (const name of ["archive", "..", "notes.md"]) {
      assert.equal(readFeedTail(root, name, 10).ok, false, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads only the tail of a feed too long to show, and starts on a whole line", () => {
  const root = scratch();
  try {
    const padding = "x".repeat(80);
    const lines = Array.from({ length: 2_000 }, (_unused, index) => feedLine(`line ${index} ${padding}`));
    put(root, "2026-08-06-1000/feed.ndjson", feedNdjson(lines));

    const tail = readFeedTail(root, "2026-08-06-1000", 5_000);
    assert.ok(tail.ok);
    assert.ok(tail.value.length > 0);
    assert.ok(tail.value.length < 2_000, "a feed this long is never slurped whole");
    assert.ok(tail.value.at(-1)?.text.startsWith("line 1999 "), "the newest line is always there");
    assert.ok(!tail.value.some((line) => line.text.startsWith("line 0 ")), "the oldest is outside the window");
    assert.ok(tail.value.every((line) => line.text.endsWith(padding)), "no half line survives the window");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips a line that is not a feed line and keeps the ones around it", () => {
  const root = scratch();
  try {
    const text = [
      JSON.stringify(feedLine("first")),
      "{not json",
      JSON.stringify({ at: 1, scope: "a-model q01", kind: "tool", text: "at is not a string" }),
      JSON.stringify(feedLine("kind from a later build", { kind: "quantum" })),
      "null",
      "[]",
      "",
      JSON.stringify(feedLine("last")),
    ].join("\n");
    put(root, "2026-08-06-1000/feed.ndjson", `${text}\n`);

    const tail = readFeedTail(root, "2026-08-06-1000", 10);
    assert.ok(tail.ok);
    assert.deepEqual(
      tail.value.map((line) => line.text),
      ["first", "last"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Discovery follows the record, not the markdown beside it: the .json is the
// richer of the two and the only one a run must leave, so a run with no .md is
// found and one with only a .md is not.
test("groups run files by model and suite, from the records", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/runs/a-model/query/q02.json", "{}");
    put(root, "2026-08-06-1000/runs/a-model/query/q01.json", "{}");
    put(root, "2026-08-06-1000/runs/a-model/query/q01.md", "#");
    put(root, "2026-08-06-1000/runs/b-model/record/card.json", "{}");
    // Markdown with no record beside it is not a run this listing knows about.
    put(root, "2026-08-06-1000/runs/b-model/record/orphan.md", "#");
    put(root, "2026-08-06-1000/benchmark.json", benchmarkJson());

    const runs = listRunFiles(root, "2026-08-06-1000");
    assert.ok(runs.ok);
    assert.deepEqual(runs.value, [
      { model: "a-model", suite: "query", stems: ["q01", "q02"] },
      { model: "b-model", suite: "record", stems: ["card"] },
    ]);

    put(root, "2026-08-06-1001/benchmark.json", benchmarkJson());
    assert.deepEqual(listRunFiles(root, "2026-08-06-1001"), { ok: true, value: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "a/model",
    suite: "query",
    caseId: "q01",
    trial: 1,
    state: "graded",
    error: null,
    grade: { caseId: "q01", assertions: [], passRate: 1, passed: true },
    metrics: { durationMs: 4_000, tokensIn: 10, tokensOut: 2, tokensEstimated: false },
    events: [],
    ...patch,
  });
}

test("reads a run's record through the same whitelist the markdown goes through", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/runs/a-model/query/q01.json", runJson({ caseId: "q01" }));
    put(root, "secret.json", runJson({ caseId: "not yours" }));

    const record = readRunRecord(root, "2026-08-06-1000", "a-model", "query", "q01");
    assert.ok(record.ok);
    assert.equal(record.value.caseId, "q01");
    assert.equal(record.value.model, "a/model");

    const hostile: [string, string, string, string][] = [
      ["2026-08-06-1000", "..", "query", "q01"],
      ["2026-08-06-1000", "a-model", "query", "../../../secret"],
      ["2026-08-06-1000", "a-model", "query", "q01.json"],
      ["archive", "a-model", "query", "q01"],
    ];
    for (const [slug, model, suite, stem] of hostile) {
      assert.equal(readRunRecord(root, slug, model, suite, stem).ok, false, [slug, model, suite, stem].join("/"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a run file that is missing, unparseable, or not shaped like a record", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/runs/a-model/query/bad-json.json", "{not json");
    put(root, "2026-08-06-1000/runs/a-model/query/no-events.json", runJson({ events: undefined }));
    put(root, "2026-08-06-1000/runs/a-model/query/no-metrics.json", runJson({ metrics: null }));
    put(root, "2026-08-06-1000/runs/a-model/query/not-an-object.json", "[]");

    for (const stem of ["bad-json", "no-events", "no-metrics", "not-an-object", "never-written"]) {
      assert.equal(readRunRecord(root, "2026-08-06-1000", "a-model", "query", stem).ok, false, stem);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads every run file of an iteration, carrying an unreadable record as null", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/runs/a-model/query/q01.md", "# q01");
    put(root, "2026-08-06-1000/runs/a-model/query/q01.json", runJson({ caseId: "q01" }));
    // A record too broken to parse is carried as null rather than dropped: the
    // run happened, and a listing that hid it would say it did not.
    put(root, "2026-08-06-1000/runs/a-model/query/q02.md", "# q02");
    put(root, "2026-08-06-1000/runs/a-model/query/q02.json", "{not json");
    put(root, "2026-08-06-1000/runs/b-model/record/card.json", runJson({ caseId: "card" }));

    const runs = listRunRecords(root, "2026-08-06-1000");
    assert.ok(runs.ok);
    assert.deepEqual(
      runs.value.map((run) => [run.model, run.suite, run.stem, run.record?.caseId ?? null]),
      [
        ["a-model", "query", "q01", "q01"],
        ["a-model", "query", "q02", null],
        ["b-model", "record", "card", "card"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses every smuggled name, decoded or not, before anything is joined", () => {
  const root = scratch();
  try {
    put(root, "2026-08-06-1000/runs/a-model/query/q01.json", runJson());
    put(root, "secret.json", "not yours");

    const hostile: [string, string, string, string][] = [
      ["2026-08-06-1000", "..", "query", "q01"],
      ["2026-08-06-1000", "../..", "query", "q01"],
      ["2026-08-06-1000", "a-model", "..", "q01"],
      ["2026-08-06-1000", "a-model", "query", "../../../../secret"],
      ["2026-08-06-1000", "a-model", "query", "q01.json"],
      ["2026-08-06-1000", "a-model", "query", "q0"],
      ["2026-08-06-1000", "A-Model", "query", "q01"],
      ["..", "a-model", "query", "q01"],
      ["archive", "a-model", "query", "q01"],
    ];
    for (const [slug, model, suite, stem] of hostile) {
      const resolved = readRunRecord(root, slug, model, suite, stem);
      assert.equal(resolved.ok, false, [slug, model, suite, stem].join("/"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
