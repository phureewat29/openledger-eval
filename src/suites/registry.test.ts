import assert from "node:assert/strict";
import { test } from "node:test";
import { SUITE_IDS } from "../shared/vocabulary.js";
import { SUITES } from "./registry.js";

const SKILL = "# OpenLedger skill\n\nAlways read the ledger back.";

/**
 * The invariant the harness exists for: every run measures CLI + SKILL.md. A
 * suite that dropped or buried the skill text would grade the environment
 * adapter instead, with a valid-looking skill hash in the report — so the text
 * must open the prompt verbatim, with the adapter after it.
 */
test("every registered suite opens its system prompt with the skill text, environment after", () => {
  for (const suite of SUITES) {
    const prompt = suite.systemPrompt(`\n${SKILL}\n`);
    assert.equal(prompt.indexOf(SKILL), 0, `${suite.id} does not open with the skill text`);
    assert.ok(prompt.includes("## This environment"), `${suite.id} lost the environment adapter`);
  }
});

// A suite id the config accepts but the registry lacks is skipped at run time
// with only a warning — this is the loud version.
test("the registry carries exactly the suite ids the config accepts", () => {
  assert.deepEqual(SUITES.map((suite) => suite.id).toSorted(), SUITE_IDS.toSorted());
});
