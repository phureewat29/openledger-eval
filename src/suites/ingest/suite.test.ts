import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OpenLedgerRunner } from "../../oled/command.js";
import type { SuiteContext } from "../types.js";
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

const NEVER_RUNS: OpenLedgerRunner = {
  run: () => Promise.reject(new Error("preparing an ingest case must not run a command")),
};

/** prepare only seeds the statement into the workspace, so the stub needs one writable directory and nothing else. */
function contextIn(root: string): SuiteContext {
  return { runner: NEVER_RUNS, workspace: { data: join(root, "data") } } as unknown as SuiteContext;
}

/**
 * SKILL.md and `--help` are what this suite measures, so a phase prompt that
 * explained the CLI would be measuring the prompt; "Ingest my new statements"
 * stays legal — naming the job is not naming the command.
 */
test("no phase says anything about oled, its flags, or how to batch", async () => {
  const loaded = ingestSuite.cases(FIXTURES);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);

  const root = mkdtempSync(join(tmpdir(), "oled-eval-ingest-test-"));
  try {
    for (const kase of loaded.value) {
      const prepared = await ingestSuite.prepare(contextIn(root), kase);
      assert.ok(prepared.ok, prepared.ok ? "" : prepared.error);
      for (const phase of prepared.value) {
        for (const forbidden of [/\boled\b/i, /--\w/, /\bstdin\b/i, /\bbatch/i, /ingest commit/i]) {
          assert.doesNotMatch(phase.prompt, forbidden, `${kase.id} ${phase.id} leaks usage advice`);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
