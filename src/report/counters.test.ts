import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCounters } from "./counters.js";
import type { RunEvent } from "./events.js";

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

test("counts nothing on a run that never called a tool", () => {
  const counters = buildCounters([]);
  assert.deepEqual(counters.rejected, {
    unknown_tool: 0,
    bad_tool_args: 0,
    refused_shell: 0,
    refused_placeholder: 0,
    refused_command: 0,
  });
  assert.deepEqual(counters.nonzeroExits, {});
  assert.equal(counters.helpCalls, 0);
  assert.equal(counters.repeatedCommands, 0);
  assert.equal(counters.contextTrims, 0);
});

test("counts refused calls by kind", () => {
  const counters = buildCounters([
    call({ rejected: "refused_shell", exitCode: null, ok: false, command: "oled a | b" }),
    call({ rejected: "refused_shell", exitCode: null, ok: false, command: "oled c | d" }),
    call({ rejected: "bad_tool_args", exitCode: null, ok: false, command: "oled" }),
  ]);
  assert.equal(counters.rejected.refused_shell, 2);
  assert.equal(counters.rejected.bad_tool_args, 1);
  assert.equal(counters.rejected.unknown_tool, 0);
});

test("names non-zero exits by the contract, and skips calls that never ran", () => {
  const counters = buildCounters([
    call({ exitCode: 2, ok: false, command: "oled a" }),
    call({ exitCode: 2, ok: false, command: "oled b" }),
    call({ exitCode: 5, ok: false, command: "oled c" }),
    call({ exitCode: 99, ok: false, command: "oled d" }),
    call({ exitCode: 0, command: "oled e" }),
    call({ exitCode: null, ok: false, rejected: "refused_command", command: "oled f" }),
  ]);
  assert.deepEqual(counters.nonzeroExits, { USAGE: 2, NOT_FOUND: 1, "UNKNOWN(99)": 1 });
});

test("counts a help flag only when it is a whole argument", () => {
  const counters = buildCounters([
    call({ args: "ingest --help", command: "oled ingest --help" }),
    call({ args: "-h", command: "oled -h" }),
    call({ args: "transactions list --host kbank", command: "oled transactions list --host kbank" }),
  ]);
  assert.equal(counters.helpCalls, 2);
});

test("counts every repeat of a command that ran, spacing aside", () => {
  const counters = buildCounters([
    call({ command: "oled status --json" }),
    call({ command: "oled  status   --json" }),
    call({ command: "oled status --json" }),
    call({ command: "oled questions list --json" }),
    call({ command: "oled questions list --json" }),
    call({ command: "oled ingest done --json" }),
    // Refused twice over: friction the rejection counter already holds.
    call({ command: "oled", exitCode: null, ok: false, rejected: "bad_tool_args" }),
    call({ command: "oled", exitCode: null, ok: false, rejected: "bad_tool_args" }),
  ]);
  assert.equal(counters.repeatedCommands, 3);
});

/**
 * argv is identical for every commit; the rows are not. A suite whose whole method
 * is a sequence of commits with different payloads would otherwise report its
 * honest path as a run that did the same thing over and over.
 */
test("two commits of different rows are two commands, and the same rows twice is one repeat", () => {
  const commit = (digest: string) =>
    call({
      subcommand: "ingest commit",
      command: "oled ingest commit --json",
      stdin: true,
      stdinDigest: digest,
      rows: 25,
    });
  assert.equal(buildCounters([commit("aaaa1111"), commit("bbbb2222")]).repeatedCommands, 0);
  assert.equal(buildCounters([commit("aaaa1111"), commit("aaaa1111")]).repeatedCommands, 1);
});

test("counts context trims", () => {
  const trim: RunEvent = { type: "context_trim", phase: "ingest" };
  assert.equal(buildCounters([trim, call(), trim]).contextTrims, 2);
});
