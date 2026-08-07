import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ingestSuite } from "./suite.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));

test("loads the checked-in statement, which reconciles with its own summary box", () => {
  const cases = ingestSuite.cases(FIXTURES);
  assert.ok(cases.ok, cases.ok ? "" : cases.error);
  assert.equal(cases.value.length, 1);

  const kase = cases.value[0];
  assert.ok(kase);
  assert.equal(kase.id, "card-statement-2026-05");
  assert.match(kase.pdf, /fixtures\/ingest\/card-statement-2026-05\.pdf$/);
  assert.equal(kase.facts.statement, "card-statement-2026-05.pdf");
});

test("reports a missing fixture instead of planning a run against nothing", () => {
  const cases = ingestSuite.cases("/nonexistent/fixtures");
  assert.equal(cases.ok, false);
});

test("builds a system prompt from the skill text", () => {
  const prompt = ingestSuite.systemPrompt("# Skill\n\nDo the thing.");
  assert.match(prompt, /Do the thing\./);
  assert.match(prompt, /## This environment/);
});
