import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlannedRun } from "../runner/matrix.js";
import { gradeOf, type AssertionResult } from "../suites/types.js";
import { buildCounters } from "./counters.js";
import type { RunEvent } from "./events.js";
import {
  createFeedWriter,
  formatEvent,
  formatHeader,
  formatRunFinish,
  formatRunStart,
  type FeedLine,
} from "./feed.js";
import type { RunRecord } from "./record.js";
import { createRecorder } from "./recorder.js";

const NOW = new Date("2026-08-06T09:05:00.000Z");

function planned(modelId = "google/gemini-3.6-flash", caseId = "q01", trial = 1): PlannedRun {
  return {
    model: { id: modelId, modalities: ["text"], contextLength: 128_000, supportsTools: true, pricing: null },
    suite: {
      id: "query",
      cases: () => ({ ok: true, value: [] }),
      prepare: async () => ({ ok: true, value: [] }),
      systemPrompt: () => "",
      tools: () => [],
      score: ({ kase }) => gradeOf(kase.id, []),
    },
    kase: { id: caseId },
    trial,
  };
}

type ToolCall = Extract<RunEvent, { type: "tool_call" }>;

function call(patch: Partial<ToolCall> = {}): ToolCall {
  return {
    type: "tool_call",
    phase: "ingest",
    turn: 1,
    durationMs: 5,
    tool: "oled",
    subcommand: "status",
    args: "status",
    command: "oled status --json",
    ok: true,
    exitCode: 0,
    rejected: null,
    message: "",
    hint: null,
    stdin: false,
    stdinPreview: null,
    stdinDigest: null,
    rows: null,
    commit: null,
    result: "{}",
    ...patch,
  };
}

type LlmCall = Extract<RunEvent, { type: "llm_call" }>;

function llm(content: string, patch: Partial<LlmCall> = {}): LlmCall {
  return {
    type: "llm_call",
    phase: "ingest",
    turn: 1,
    content,
    finishReason: "stop",
    toolCalls: 0,
    usage: { promptTokens: 10, completionTokens: 5, estimated: false },
    durationMs: 900,
    ...patch,
  };
}

function record(patch: Partial<RunRecord> = {}): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: "google/gemini-3.6-flash",
    suite: "query",
    caseId: "q01",
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

function check(id: string, passed: boolean): AssertionResult {
  return { id, label: id, passed, evidence: { want: "1", got: passed ? "1" : "2" } };
}

/** One line, or a failed assertion: the null arm is tested where null is the expectation. */
function textOf(event: RunEvent, run: PlannedRun = planned()): string {
  const line = formatEvent(run, event, NOW);
  assert.ok(line, "expected this event to produce a feed line");
  return line.text;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "oled-eval-feed-"));
}

test("a phase start and its every exit read as one phase line", () => {
  assert.equal(textOf({ type: "phase_start", phase: "ingest", title: "Card statement" }), "phase ingest");
  assert.equal(
    textOf({ type: "phase_end", phase: "ingest", reply: "done", exit: "answered" }),
    "phase ingest ended: answered",
  );
  assert.equal(
    textOf({ type: "phase_end", phase: "ingest", reply: "", exit: "call_cap" }),
    "phase ingest ended: call_cap",
  );
  assert.equal(
    textOf({ type: "phase_end", phase: "answer", reply: "", exit: "stalled" }),
    "phase answer ended: stalled",
  );

  const line = formatEvent(planned(), { type: "phase_start", phase: "ingest", title: "t" }, NOW);
  assert.equal(line?.kind, "phase");
});

test("a model reply is a says line, and a tool-only turn is no line at all", () => {
  const said = formatEvent(planned(), llm("Posting 126 rows now."), NOW);
  assert.deepEqual(
    [said?.kind, said?.text, said?.at],
    ["says", "Posting 126 rows now.", "2026-08-06T09:05:00.000Z"],
  );
  assert.equal(formatEvent(planned(), llm(""), NOW), null);
  assert.equal(formatEvent(planned(), llm("   \n  "), NOW), null, "whitespace is not something said");
});

function commitCall(patch: Partial<ToolCall> = {}): ToolCall {
  return call({ subcommand: "ingest commit", command: "oled ingest commit --json", stdin: true, ...patch });
}

test("a commit reports its exit, the rows it was sent and the rows it posted", () => {
  const line = formatEvent(
    planned(),
    commitCall({ rows: 126, commit: { posted: 126, duplicates: 0, failed: 0, questionsRaised: 0 } }),
    NOW,
  );

  assert.equal(line?.kind, "tool");
  assert.equal(line?.text, "oled ingest commit → exit 0 · 126 rows · 126 posted");
});

test("the rows a commit piped stay off the feed, which is one line per event", () => {
  const rows = '{"amount":-42.5,"merchant":"a shop"}\n{"amount":-9,"merchant":"another"}';
  const line = formatEvent(planned(), commitCall({ rows: 2, stdinPreview: rows }), NOW);

  assert.equal(line?.text, "oled ingest commit → exit 0 · 2 rows");
  assert.ok(!line?.text.includes("merchant"), "the payload belongs to the run page, not to a scannable feed");
  assert.ok(!line?.text.includes("\n"));
});

test("a partial commit reports what it duplicated, failed and asked, and not its summary row", () => {
  const text = textOf(
    commitCall({
      ok: false,
      exitCode: 7,
      rows: 128,
      commit: { posted: 2, duplicates: 4, failed: 122, questionsRaised: 3 },
      message: '{"type":"summary","posted":2,"duplicates":4,"failed":122,"raised_questions":3}',
    }),
  );

  assert.equal(
    text,
    "oled ingest commit → exit 7 · 128 rows · 2 posted · 4 duplicates · 122 failed · 3 questions",
  );
});

test("a refused call names the rejection and its message, and shows no exit it never had", () => {
  const text = textOf(
    call({
      subcommand: "transactions list",
      ok: false,
      exitCode: null,
      rejected: "refused_shell",
      message: "refused: args cannot contain | & ; < > ` or $.",
    }),
  );

  assert.equal(
    text,
    "oled transactions list refused: refused_shell · refused: args cannot contain | & ; < > ` or $.",
  );
});

test("a non-zero exit shows the error oled reported and the hint it offered", () => {
  const text = textOf(
    call({
      subcommand: "transactions list",
      ok: false,
      exitCode: 2,
      message: '{"error":{"code":"E_USAGE","message":"unknown option \'--merchant\'","hint":"run `oled transactions list --help`"}}',
      hint: "run `oled transactions list --help`",
    }),
  );

  assert.equal(
    text,
    "oled transactions list → exit 2 · unknown option '--merchant' · hint: run `oled transactions list --help`",
  );
});

test("a stderr line that is not oled's error envelope is shown as it arrived", () => {
  const text = textOf(call({ ok: false, exitCode: 1, message: "sqlite is locked" }));
  assert.equal(text, "oled status → exit 1 · sqlite is locked");
});

test("a call that never reached a process reports its message instead of an exit", () => {
  assert.equal(
    textOf(call({ tool: "submit_answer", subcommand: "submit_answer", exitCode: null, message: "There are 40 transactions." })),
    "submit_answer → There are 40 transactions.",
  );
  assert.equal(
    textOf(call({ subcommand: "report", ok: false, exitCode: null, message: "timeout: oled report --json exceeded 120000ms" })),
    "oled report → timeout: oled report --json exceeded 120000ms",
  );
});

test("operational notes and context trims are note lines", () => {
  const note = formatEvent(
    planned(),
    { type: "operational", phase: "answer", operation: "stall_prod", detail: "prod 1: empty reply with no tool call" },
    NOW,
  );
  assert.equal(note?.kind, "note");
  assert.equal(note?.text, "stall_prod: prod 1: empty reply with no tool call");

  const trim = formatEvent(planned(), { type: "context_trim", phase: "ingest" }, NOW);
  assert.equal(trim?.kind, "note");
  assert.equal(trim?.text, "trimmed the oldest turns to fit the context window");
});

test("scope drops the vendor prefix and names the trial only past the first", () => {
  const event: RunEvent = { type: "phase_start", phase: "ingest", title: "t" };
  assert.equal(formatEvent(planned("google/gemini-3.6-flash", "q01"), event, NOW)?.scope, "gemini-3.6-flash q01");
  assert.equal(formatEvent(planned("google/gemini-3.6-flash", "q01", 2), event, NOW)?.scope, "gemini-3.6-flash q01 t2");
  assert.equal(formatEvent(planned("solo-model", "card-2026-05"), event, NOW)?.scope, "solo-model card-2026-05");
});

test("text is flattened to one line and capped at 200 characters", () => {
  const long = formatEvent(planned(), llm("x".repeat(300)), NOW);
  assert.equal(long?.text.length, 200);
  assert.ok(long?.text.endsWith("…"), "a cut line has to say it was cut");

  const wrapped = formatEvent(planned(), llm("I will\n\nfirst read  the ledger."), NOW);
  assert.equal(wrapped?.text, "I will first read the ledger.");
});

test("a run start is one run line", () => {
  const line = formatRunStart(planned("google/gemini-3.6-flash", "q01", 2), NOW);
  assert.deepEqual(line, {
    at: "2026-08-06T09:05:00.000Z",
    scope: "gemini-3.6-flash q01 t2",
    kind: "run",
    text: "started",
  });
});

test("a graded run reports the checks it passed, an n/a check counting in neither half", () => {
  const assertions: AssertionResult[] = [
    ...Array.from({ length: 11 }, (_unused, index) => check(`a${index}`, true)),
    check("miss", false),
    { id: "skipped", label: "skipped", passed: false, na: true, evidence: { want: "n/a", got: "no data" } },
  ];
  const empty = createRecorder().snapshot();

  const line = formatRunFinish(
    record({ grade: gradeOf("q01", assertions), metrics: { ...empty.metrics, durationMs: 6_000 } }),
    NOW,
  );

  assert.equal(line.kind, "result");
  assert.equal(line.scope, "gemini-3.6-flash q01");
  assert.equal(line.text, "scored 11/12 checks · 6s");
});

test("a run that failed reports which side failed and why", () => {
  assert.equal(
    formatRunFinish(record({ state: "endpoint_error", error: "429 after 3 attempts" }), NOW).text,
    "endpoint_error: 429 after 3 attempts",
  );
  assert.equal(
    formatRunFinish(record({ state: "sandbox_error", error: "npm install failed" }), NOW).text,
    "sandbox_error: npm install failed",
  );
  assert.equal(
    formatRunFinish(record({ state: "sandbox_error", error: null }), NOW).text,
    "sandbox_error: no error was recorded",
  );
});

test("a header line belongs to the invocation, not to a cell", () => {
  assert.deepEqual(formatHeader("oled 1.2.3 · eval 1.0.0", NOW), {
    at: "2026-08-06T09:05:00.000Z",
    scope: "eval",
    kind: "header",
    text: "oled 1.2.3 · eval 1.0.0",
  });
});

test("createFeedWriter appends one JSON object per line, in the order it was given them", () => {
  const dir = scratch();
  try {
    const writer = createFeedWriter(dir);
    writer.header(["oled 1.2.3", "2 runs at concurrency 2"]);
    writer.line(formatRunStart(planned(), NOW));
    writer.line(formatRunFinish(record({ grade: gradeOf("q01", [check("only", true)]) }), NOW));

    const text = readFileSync(join(dir, "feed.ndjson"), "utf8");
    assert.ok(text.endsWith("\n"), "every line is terminated, so a reader never sees a partial one");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as FeedLine);
    assert.deepEqual(
      lines.map((line) => [line.kind, line.text]),
      [
        ["header", "oled 1.2.3"],
        ["header", "2 runs at concurrency 2"],
        ["run", "started"],
        ["result", "scored 1/1 checks · 0s"],
      ],
    );
    assert.ok(lines.every((line) => !Number.isNaN(Date.parse(line.at))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createFeedWriter warns once and never throws when the feed cannot be written", (t) => {
  const stderr = t.mock.method(process.stderr, "write", (): boolean => true);
  const dir = scratch();
  try {
    const writer = createFeedWriter(join(dir, "gone"));
    writer.header(["oled 1.2.3"]);
    writer.line(formatRunStart(planned(), NOW));
    writer.line(formatRunFinish(record({ grade: gradeOf("q01", []) }), NOW));

    assert.equal(stderr.mock.callCount(), 1, "one warning, then silence");
    assert.match(String(stderr.mock.calls[0]?.arguments[0]), /cannot append to .*feed\.ndjson/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
