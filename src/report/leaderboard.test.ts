import assert from "node:assert/strict";
import { test } from "node:test";
import type { Benchmark, BenchmarkEntry, ConfigEcho } from "./benchmark.js";
import { humanDuration, humanTokens, LEADERBOARD_COLUMNS, renderLeaderboard, suiteRows } from "./leaderboard.js";
import type { RunIdentity } from "./record.js";

const IDENTITY: RunIdentity = {
  startedAt: "2026-08-06T09:05:00.000Z",
  oledVersion: "1.2.3",
  suiteSha256: `a1b2c3d4e5f6${"0".repeat(52)}`,
  skillVersion: "2.0.0",
  skillSha256: `f6e5d4c3b2a1${"0".repeat(52)}`,
  evalVersion: "1.0.0",
};

function entry(patch: Partial<BenchmarkEntry> = {}): BenchmarkEntry {
  return {
    model: "anthropic/claude-sonnet-4.5",
    suite: "record",
    trials: 1,
    cases: { passed: 8, total: 9 },
    meanPassRate: 0.833,
    stddevPassRate: null,
    avgDurationMs: 58_000,
    avgTokens: { in: 375_000, out: 10_000 },
    avgToolCalls: 6.3,
    totalCostUsd: 0.0123,
    terminal: { graded: 9, endpoint_error: 0, sandbox_error: 0 },
    ...patch,
  };
}

function config(patch: Partial<ConfigEcho> = {}): ConfigEcho {
  return { suites: ["record", "query"], trials: 1, concurrency: 2, modelsRequested: [], ...patch };
}

function benchmark(patch: Partial<Benchmark> = {}): Benchmark {
  return {
    schemaVersion: 1,
    identity: IDENTITY,
    config: config(),
    entries: [entry()],
    buildDrift: null,
    skippedModels: [],
    ...patch,
  };
}

/** Data rows only: drops the header row and the "---" separator row. */
function tableLines(markdown: string, suite: string): string[] {
  const heading = `## ${suite}`;
  const start = markdown.indexOf(heading);
  assert.ok(start !== -1, `no ${heading} section in:\n${markdown}`);
  return markdown
    .slice(start)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.includes("---") && !line.includes("Pass rate"));
}

test("medals the top three rows of the suite table", () => {
  const rows = [
    entry({ model: "a/model", meanPassRate: 0.9 }),
    entry({ model: "b/model", meanPassRate: 0.6 }),
    entry({ model: "c/model", meanPassRate: 0.5 }),
    entry({ model: "d/model", meanPassRate: 0.4 }),
    entry({ model: "e/model", meanPassRate: 0.3 }),
  ];
  const lines = tableLines(renderLeaderboard(benchmark({ entries: rows })), "record");
  assert.equal(lines.length, 5);
  assert.ok(lines[0]?.startsWith("| 1 🥇 |"));
  assert.ok(lines[1]?.startsWith("| 2 🥈 |"));
  assert.ok(lines[2]?.startsWith("| 3 🥉 |"));
  assert.ok(lines[3]?.startsWith("| 4 |"));
  assert.ok(lines[4]?.startsWith("| 5 |"));
});

test("renders cases as a raw-count fraction", () => {
  const markdown = renderLeaderboard(benchmark({ entries: [entry({ cases: { passed: 7, total: 9 } })] }));
  assert.ok(markdown.includes("| 7/9 |"));
});

test("shows a stddev suffix only when one is present", () => {
  const withStddev = renderLeaderboard(
    benchmark({ entries: [entry({ meanPassRate: 0.833, stddevPassRate: 0.042 })] }),
  );
  assert.ok(withStddev.includes("83.3% ±4.2"));

  const without = renderLeaderboard(benchmark({ entries: [entry({ stddevPassRate: null })] }));
  assert.ok(!without.includes("±"));
});

test("renders a dash for an unpriced entry and four decimals for a priced one", () => {
  const priced = renderLeaderboard(benchmark({ entries: [entry({ totalCostUsd: 0.0123 })] }));
  assert.ok(priced.includes("$0.0123"));

  const unpriced = renderLeaderboard(benchmark({ entries: [entry({ totalCostUsd: null })] }));
  assert.ok(unpriced.includes("| — |"));
});

test("formats tool calls to one decimal", () => {
  const markdown = renderLeaderboard(benchmark({ entries: [entry({ avgToolCalls: 6.34 })] }));
  assert.ok(markdown.includes("| 6.3 |"));
});

test("renders average tokens as in / out, each humanized", () => {
  const markdown = renderLeaderboard(
    benchmark({ entries: [entry({ avgTokens: { in: 375_000, out: 10_000 } })] }),
  );
  assert.ok(markdown.includes("375K / 10K"));
});

test("prints a skipped-models section only when something was skipped", () => {
  const present = renderLeaderboard(benchmark({ skippedModels: [{ id: "vendor/nope", reason: "no tool calling" }] }));
  assert.ok(present.includes("## Skipped models"));
  assert.ok(present.includes("vendor/nope — no tool calling"));

  const absent = renderLeaderboard(benchmark({ skippedModels: [] }));
  assert.ok(!absent.includes("## Skipped models"));
});

test("flags an entry that had any endpoint or sandbox error", () => {
  const markdown = renderLeaderboard(
    benchmark({ entries: [entry({ terminal: { graded: 7, endpoint_error: 1, sandbox_error: 1 } })] }),
  );
  assert.ok(markdown.includes("⚠ 2 failed runs"));
});

test("groups entries into a table per suite, in suite order", () => {
  const rows = [entry({ suite: "record" }), entry({ suite: "query", model: "b/model" })];
  const markdown = renderLeaderboard(benchmark({ entries: rows }));
  const recordIndex = markdown.indexOf("## record");
  const queryIndex = markdown.indexOf("## query");
  assert.ok(recordIndex !== -1 && queryIndex !== -1);
  assert.ok(recordIndex < queryIndex);
});

test("prints the identity block: versions, truncated shas, and the config echo", () => {
  const markdown = renderLeaderboard(benchmark());
  assert.ok(markdown.startsWith("# openledger eval — 2026-08-06T09:05:00.000Z\n"));
  assert.ok(markdown.includes("oled `1.2.3`"));
  assert.ok(markdown.includes("questions `a1b2c3d4e5f6`"));
  assert.ok(!markdown.includes(IDENTITY.suiteSha256), "the full 64-char sha should not appear, only its prefix");
  assert.ok(markdown.includes("skill `2.0.0` `f6e5d4c3b2a1`"));
  assert.ok(markdown.includes("eval `1.0.0`"));
  assert.ok(markdown.includes("suites: record, query · trials: 1 · concurrency: 2"));
});

test("suiteRows returns one cell per column, ranked by position, using the rankCell/passRateCell formatting the HTML table also imports", () => {
  const rows = suiteRows([
    entry({ model: "a/model", meanPassRate: 0.9, stddevPassRate: 0.042 }),
    entry({ model: "b/model", totalCostUsd: null, terminal: { graded: 7, endpoint_error: 1, sandbox_error: 1 } }),
  ]);
  assert.equal(rows.length, 2);
  for (const cells of rows) assert.equal(cells.length, LEADERBOARD_COLUMNS.length);
  assert.deepEqual(rows[0], ["1 🥇", "a/model", "8/9", "90.0% ±4.2", "58s", "375K / 10K", "$0.0123", "6.3", ""]);
  assert.deepEqual(rows[1], ["2 🥈", "b/model", "8/9", "83.3%", "58s", "375K / 10K", "—", "6.3", "⚠ 2 failed runs"]);
});

test("humanTokens keeps small counts verbatim and abbreviates with K/M above 1000", () => {
  assert.equal(humanTokens(999), "999");
  assert.equal(humanTokens(1_000), "1K");
  assert.equal(humanTokens(1_500_000), "1.5M");
  assert.equal(humanTokens(375_000), "375K");
});

test("humanDuration steps from seconds to minutes to hours, dropping the smaller unit each time", () => {
  assert.equal(humanDuration(59_000), "59s");
  assert.equal(humanDuration(60_000), "1m00s");
  assert.equal(humanDuration(83_000), "1m23s");
  assert.equal(humanDuration(3_661_000), "1h01m");
});

/**
 * A merged report is allowed to span builds — a rerun always lands in the report
 * it came from — so the only unacceptable outcome is saying nothing about it.
 */
test("a report that spans builds says so above its tables", () => {
  const markdown = renderLeaderboard(benchmark({ buildDrift: "spans more than one build: SKILL.md 2cf3269d1708 → 9a1e77b04c22" }));
  assert.ok(markdown.includes("spans more than one build"));
  assert.ok(markdown.includes("SKILL.md 2cf3269d1708 → 9a1e77b04c22"));
});

test("an ordinary report carries no such line", () => {
  assert.ok(!renderLeaderboard(benchmark()).includes("spans more than one build"));
});
