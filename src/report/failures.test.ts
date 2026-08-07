import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeOf, type AssertionResult } from "../suites/types.js";
import { topFailures } from "./failures.js";
import type { RunRecord } from "./record.js";

function check(id: string, passed: boolean, patch: Partial<AssertionResult> = {}): AssertionResult {
  return { id, label: `the ${id} check`, passed, evidence: { want: "x", got: "y" }, ...patch };
}

function run(caseId: string, assertions: AssertionResult[]): RunRecord {
  return {
    model: "a/model",
    suite: "record",
    caseId,
    trial: 1,
    state: "graded",
    error: null,
    grade: gradeOf(caseId, assertions),
    metrics: {
      llmCalls: 1,
      toolCalls: 1,
      tokensIn: 1,
      tokensOut: 1,
      tokensEstimated: false,
      llmMs: 1,
      toolMs: 1,
      durationMs: 2,
      contextTrims: 0,
    },
    counters: {
      rejected: { unknown_tool: 0, bad_tool_args: 0, refused_shell: 0, refused_placeholder: 0, refused_command: 0 },
      nonzeroExits: {},
      helpCalls: 0,
      repeatedCommands: 0,
      contextTrims: 0,
    },
    questionsRaised: 0,
    costUsd: null,
    events: [],
  };
}

test("names the checks that failed in the most runs, worst first", () => {
  const records = [
    run("c1", [check("rows_posted", false), check("net_worth", false), check("file_closed", true)]),
    run("c2", [check("rows_posted", false), check("net_worth", true), check("file_closed", false)]),
    run("c3", [check("rows_posted", false), check("net_worth", false), check("file_closed", true)]),
  ];

  assert.deepEqual(topFailures(records, 4), [
    { id: "rows_posted", label: "the rows_posted check", runs: 3 },
    { id: "net_worth", label: "the net_worth check", runs: 2 },
    { id: "file_closed", label: "the file_closed check", runs: 1 },
  ]);
});

test("keeps only the worst few, and breaks a tie on the id so the list never reorders itself", () => {
  const records = [run("c1", [check("b_check", false), check("a_check", false), check("c_check", false)])];
  assert.deepEqual(
    topFailures(records, 2).map((failure) => failure.id),
    ["a_check", "b_check"],
  );
});

test("an n/a check had nothing to judge, so it is never counted as a failure", () => {
  const records = [
    run("c1", [check("uncategorized_ratio", false, { na: true }), check("rows_posted", false)]),
    run("c2", [check("uncategorized_ratio", false, { na: true })]),
  ];
  assert.deepEqual(topFailures(records, 4), [{ id: "rows_posted", label: "the rows_posted check", runs: 1 }]);
});

test("has nothing to report for runs that passed everything, or that were never graded", () => {
  assert.deepEqual(topFailures([run("c1", [check("rows_posted", true)])], 4), []);
  assert.deepEqual(topFailures([{ ...run("c1", []), state: "endpoint_error", grade: null }], 4), []);
  assert.deepEqual(topFailures([], 4), []);
});
