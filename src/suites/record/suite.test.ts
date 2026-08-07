import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OpenLedgerRunner } from "../../oled/command.js";
import type { AnswerSink, SuiteContext } from "../types.js";
import { RESOLVE_MAX_CALLS, type RecordCase } from "./cases.js";
import { recordSuite } from "./suite.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));

const NEVER_RUNS: OpenLedgerRunner = {
  run: () => Promise.reject(new Error("preparing a record case must not run a command")),
};

const CONTEXT = { runner: NEVER_RUNS } as unknown as SuiteContext;

const SINK: AnswerSink = { submitted: null };

function cases(): RecordCase[] {
  const loaded = recordSuite.cases(FIXTURES);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  return loaded.value;
}

function firstCase(): RecordCase {
  const kase = cases()[0];
  assert.ok(kase);
  return kase;
}

test("the suite is registered under record and loads every checked-in case", () => {
  assert.equal(recordSuite.id, "record");
  assert.equal(cases().length, 5);
});

/**
 * Two phases, because recording and cleaning up after yourself are two asks and
 * one phase scores them as one. Without the second, the case built around a
 * refusal and a recovery scores below a case that never met the problem.
 */
test("two phases per case: record on the case's own cap, then resolve on a fixed one", async () => {
  for (const kase of cases()) {
    const prepared = await recordSuite.prepare(CONTEXT, kase);
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.error);
    assert.deepEqual(
      prepared.value.map((phase) => [phase.id, phase.maxCalls]),
      [
        ["record", kase.maxCalls],
        ["resolve", RESOLVE_MAX_CALLS],
      ],
    );
    assert.equal(prepared.value[0]?.title, "Record the transactions");
    assert.equal(RESOLVE_MAX_CALLS, 8);
  }
});

/** Deferring is not resolving, and the scorecard says so, so the ask has to say so too. */
test("the resolve phase asks for the bar the scorecard holds: nothing open, deferred or uncategorized", async () => {
  const prepared = await recordSuite.prepare(CONTEXT, firstCase());
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.error);

  const resolve = prepared.value[1];
  assert.ok(resolve);
  assert.match(resolve.prompt, /nothing should be left open, deferred or uncategorized/i);
});

test("the prompt hands over the text verbatim, the chart, and the ask", async () => {
  const kase = firstCase();
  const prepared = await recordSuite.prepare(CONTEXT, kase);
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.error);

  const prompt = prepared.value[0]?.prompt ?? "";
  assert.ok(prompt.includes(kase.inputText.trim()), "the input text is not in the prompt");
  assert.match(prompt, /Record every one of the transactions below in my ledger\./);
  for (const account of kase.accounts) {
    assert.ok(prompt.includes(`- ${account.id} — ${account.name}`), `${account.id} is not in the chart`);
  }
});

/**
 * SKILL.md and `--help` are what this suite measures, so a prompt that explained
 * the CLI would be measuring the prompt. The row count is withheld for the same
 * reason: counting the rows is part of the work.
 */
test("no phase says anything about oled, its flags, or how to batch", async () => {
  for (const kase of cases()) {
    const prepared = await recordSuite.prepare(CONTEXT, kase);
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.error);

    for (const phase of prepared.value) {
      for (const forbidden of [/\boled\b/i, /--\w/, /\bstdin\b/i, /\bbatch/i, /ingest commit/i]) {
        assert.doesNotMatch(phase.prompt, forbidden, `${kase.id} ${phase.id} leaks usage advice`);
      }
      assert.doesNotMatch(phase.prompt, new RegExp(`\\b${kase.expected.rowCount} transactions\\b`));
    }
  }
});

test("the ledger is the answer, so the only tool is oled", () => {
  assert.deepEqual(
    recordSuite.tools(CONTEXT, SINK).map((tool) => tool.name),
    ["oled"],
  );
});

test("the system prompt is the skill text and the environment, with nothing to submit", () => {
  const prompt = recordSuite.systemPrompt("# Skill\n\nRecord the rows.");
  assert.match(prompt, /Record the rows\./);
  assert.match(prompt, /## This environment/);
  assert.doesNotMatch(prompt, /submit_answer/);
});
