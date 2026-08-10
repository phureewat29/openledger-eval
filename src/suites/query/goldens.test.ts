import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANSWER_EXPECTATION,
  describeGolden,
  expectationGap,
  loadQueryQuestions,
  type QueryQuestion,
} from "./goldens.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));

function loadCases(): QueryQuestion[] {
  const cases = loadQueryQuestions(FIXTURES);
  assert.ok(cases.ok, cases.ok ? "" : cases.error);
  return cases.value;
}

test("every checked-in question loads with a shape and a way to ask the ledger", () => {
  const cases = loadCases();
  assert.equal(cases.length, 12);
  assert.deepEqual(
    cases.map((kase) => kase.id),
    ["q01", "q02", "q03", "q04", "q05", "q06", "q07", "q08", "q09", "q10", "q11", "q12"],
  );
  for (const kase of cases) {
    assert.ok(kase.shape.kind, `${kase.id} states no answer shape`);
    assert.ok(kase.derivation.op, `${kase.id} states no derivation`);
  }
});

/**
 * The values used to live in the fixture and be re-derived from the seed rows by
 * hand-rolled ledger math, which scored a model wrong whenever oled's own
 * semantics moved. A question now states only the shape of its answer; the
 * number comes back out of a seeded ledger through the CLI.
 */
test("no question carries an answer of its own", () => {
  for (const kase of loadCases()) {
    assert.ok(!("golden" in kase), `${kase.id} still carries a golden`);
    assert.ok(!("value" in kase.shape), `${kase.id} still carries a golden value`);
  }
});

test("seeds the paging rows only for the case that asks for them", () => {
  const cases = loadCases();
  const withExtra = cases.filter((kase) => kase.extraSeed !== undefined);
  assert.deepEqual(
    withExtra.map((kase) => kase.id),
    ["q11"],
  );
  const counted = cases.find((kase) => kase.id === "q01");
  assert.equal(counted?.rows.length, 40);
  assert.equal(withExtra[0]?.rows.length, 125);
});

test("reports a missing fixture directory instead of planning a run against nothing", () => {
  const cases = loadQueryQuestions("/nonexistent/fixtures");
  assert.equal(cases.ok, false);
});

test("a golden is described the same way wherever it is printed", () => {
  assert.equal(describeGolden({ kind: "count", value: 40 }), "40");
  assert.equal(describeGolden({ kind: "money", value: 10522, unit: "THB" }), "10522.00 THB");
  assert.equal(describeGolden({ kind: "number", value: 3750 }), "3750.00");
  assert.equal(describeGolden({ kind: "string", value: "Grab" }), '"Grab"');
  assert.equal(
    describeGolden({ kind: "per_currency", perCurrency: { THB: 10522, USD: 50 } }),
    "THB 10522.00, USD 50.00",
  );
});

/**
 * q09 was scored wrong because nothing told the model that `answer` had to be
 * the merchant name alone: the only instruction it had asked for "a one-line
 * summary", so it wrote one, and the exact-match scorer refused it. Every
 * question now carries the sentence its own shape calls for.
 */
test("every checked-in question says which field its answer belongs in", () => {
  for (const kase of loadCases()) {
    const wanted = ANSWER_EXPECTATION[kase.shape.kind];
    if (wanted === null) continue;
    assert.ok(kase.prompt.includes(wanted), `${kase.id} does not carry ${JSON.stringify(wanted)}`);
  }
});

test("a question whose shape moved away from its prompt refuses to load", () => {
  const gap = expectationGap({
    id: "q99",
    prompt: "Which merchant did I spend the most at?",
    shape: { kind: "string" },
  });
  assert.ok(gap);
  assert.match(gap, /q99 \(string\)/);
});

test("a question that already states its expectation has no gap", () => {
  const stated = expectationGap({
    id: "q99",
    prompt: `Which merchant? ${ANSWER_EXPECTATION.string ?? ""}`,
    shape: { kind: "string" },
  });
  assert.equal(stated, null);
});

/**
 * The one case with a per-currency golden asks whether a single total is even
 * meaningful across currencies. Naming its shape would hand the model the
 * judgement under test, so that kind states no expectation and the guard must
 * not start demanding one.
 */
test("the per-currency kind is exempt, because its shape is the question", () => {
  assert.equal(ANSWER_EXPECTATION.per_currency, null);
  const gap = expectationGap({
    id: "q12",
    prompt: "Give me one single number for everything I spent.",
    shape: { kind: "per_currency" },
  });
  assert.equal(gap, null);
});
