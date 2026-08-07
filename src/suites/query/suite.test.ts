import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findTool, type Tool } from "../../agent/tools.js";
import type { OpenLedgerRunner } from "../../oled/command.js";
import type { AnswerSink, SuiteContext } from "../types.js";
import { querySuite } from "./suite.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));

const NEVER_RUNS: OpenLedgerRunner = {
  run: () => Promise.reject(new Error("the suite wiring must not run a command")),
};

function toolsWith(sink: AnswerSink): Tool[] {
  return querySuite.tools({ runner: NEVER_RUNS } as unknown as SuiteContext, sink);
}

function submitTool(sink: AnswerSink): Tool {
  const tool = findTool(toolsWith(sink), "submit_answer");
  assert.ok(tool, "no submit_answer tool");
  return tool;
}

test("loads the checked-in questions, goldens self-checked", () => {
  const cases = querySuite.cases(FIXTURES);
  assert.ok(cases.ok, cases.ok ? "" : cases.error);
  assert.equal(cases.value.length, 12);
  assert.equal(querySuite.id, "query");
});

test("builds a system prompt from the skill text plus the submit paragraph", () => {
  const prompt = querySuite.systemPrompt("# Skill\n\nRead the ledger.");
  assert.match(prompt, /Read the ledger\./);
  assert.match(prompt, /submit_answer/);
  assert.match(prompt, /A prose reply does not end the task\./);
  assert.match(prompt, /## This environment/);
});

test("hands the model the ledger and a way to answer, nothing else", () => {
  assert.deepEqual(
    toolsWith({ submitted: null }).map((tool) => tool.name),
    ["oled", "submit_answer"],
  );
});

test("a valid submission is recorded and ends the phase", async () => {
  const sink: AnswerSink = { submitted: null };
  const result = await submitTool(sink).invoke(
    JSON.stringify({ answer: "10,522.00 THB", value: 10522, unit: "THB" }),
  );
  assert.equal(result.terminal, true);
  assert.equal(result.content, "answer recorded");
  assert.equal(result.observation.ok, true);
  assert.equal(result.observation.rejected, null);
  assert.deepEqual(sink.submitted, {
    answer: "10,522.00 THB",
    value: 10522,
    unit: "THB",
    perCurrency: undefined,
  });
});

test("per_currency arrives on the wire in snake_case", async () => {
  const sink: AnswerSink = { submitted: null };
  await submitTool(sink).invoke(
    JSON.stringify({ answer: "two currencies", per_currency: { THB: 10522, USD: 50 } }),
  );
  assert.deepEqual(sink.submitted?.perCurrency, { THB: 10522, USD: 50 });
  assert.equal(sink.submitted?.value, undefined);
});

test("a malformed submission is refused, and the phase carries on", async () => {
  const sink: AnswerSink = { submitted: null };
  const tool = submitTool(sink);
  for (const rawArgs of ["{", JSON.stringify({ answer: "" }), JSON.stringify({ value: 40 })]) {
    const result = await tool.invoke(rawArgs);
    assert.notEqual(result.terminal, true);
    assert.equal(result.observation.rejected, "bad_tool_args");
    assert.equal(sink.submitted, null);
  }
});

test("a wrongly typed value is refused rather than coerced", async () => {
  const sink: AnswerSink = { submitted: null };
  const result = await submitTool(sink).invoke(
    JSON.stringify({ answer: "ten thousand", value: "10522" }),
  );
  assert.equal(result.observation.rejected, "bad_tool_args");
  assert.equal(sink.submitted, null);
});

/**
 * The heading a run page shows comes from the phase title recorded at run time,
 * so a case carrying a separate short title could drift from the question it
 * claims to summarise — as one did, reading "Top merchant in May" while the
 * question said to rank by amount. The question is now its own heading.
 */
test("a case's heading is the question itself, not a summary of it", () => {
  const cases = querySuite.cases(FIXTURES);
  assert.ok(cases.ok, cases.ok ? "" : cases.error);
  for (const kase of cases.value) {
    assert.ok(!("title" in kase), `${kase.id} still carries a title`);
    assert.ok(kase.prompt.length > 0);
  }
});
