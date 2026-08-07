import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssertionResult, CaseGrade, SubmittedAnswer } from "../types.js";
import type { Golden, QueryCase } from "./goldens.js";
import { gradeQuery } from "./score.js";

function caseWith(golden: Golden): QueryCase {
  return {
    id: "q00",
    prompt: "How much?",
    golden,
    derivation: { op: "count", where: {} },
    rows: [],
  };
}

function answer(patch: Partial<SubmittedAnswer>): SubmittedAnswer {
  return { answer: "here it is", ...patch };
}

function assertionById(grade: CaseGrade, id: string): AssertionResult {
  const found = grade.assertions.find((check) => check.id === id);
  assert.ok(found, `no assertion ${id}`);
  return found;
}

function grade(golden: Golden, submitted: SubmittedAnswer | null): CaseGrade {
  return gradeQuery(caseWith(golden), submitted);
}

function correct(golden: Golden, submitted: SubmittedAnswer | null): boolean {
  return assertionById(grade(golden, submitted), "answer_correct").passed;
}

const COUNT: Golden = { kind: "count", value: 40 };
const MONEY: Golden = { kind: "money", value: 10522, unit: "THB" };
const NUMBER: Golden = { kind: "number", value: 3750 };
const STRING: Golden = { kind: "string", value: "Grab" };
const SPLIT: Golden = { kind: "per_currency", perCurrency: { THB: 10522, USD: 50 } };

test("every case is graded on the same two claims", () => {
  const scored = grade(COUNT, answer({ value: 40 }));
  assert.equal(scored.caseId, "q00");
  assert.deepEqual(
    scored.assertions.map((check) => check.id),
    ["submit_called", "answer_correct"],
  );
  assert.equal(scored.passRate, 1);
  assert.equal(scored.passed, true);
});

test("a count passes only on the exact whole number", () => {
  assert.equal(correct(COUNT, answer({ value: 40 })), true);
  assert.equal(correct(COUNT, answer({ value: 41 })), false);
  assert.equal(correct(COUNT, answer({ value: 40.5 })), false);
  assert.equal(correct(COUNT, answer({})), false);
});

test("a count ignores a unit nobody asked for", () => {
  assert.equal(correct(COUNT, answer({ value: 40, unit: "THB" })), true);
});

test("money passes within a satang and fails outside it", () => {
  assert.equal(correct(MONEY, answer({ value: 10522, unit: "THB" })), true);
  assert.equal(correct(MONEY, answer({ value: 10522.01, unit: "THB" })), true);
  assert.equal(correct(MONEY, answer({ value: 10521.99, unit: "THB" })), true);
  assert.equal(correct(MONEY, answer({ value: 10522.02, unit: "THB" })), false);
  assert.equal(correct(MONEY, answer({ value: 10521.98, unit: "THB" })), false);
});

test("a golden may widen its own tolerance", () => {
  const loose: Golden = { kind: "money", value: 10522, unit: "THB", tolerance: 1 };
  assert.equal(correct(loose, answer({ value: 10523, unit: "THB" })), true);
  assert.equal(correct(loose, answer({ value: 10523.01, unit: "THB" })), false);
});

test("money reads the unit case-insensitively, and needs one at all", () => {
  assert.equal(correct(MONEY, answer({ value: 10522, unit: "thb" })), true);
  assert.equal(correct(MONEY, answer({ value: 10522, unit: " THB " })), true);
  assert.equal(correct(MONEY, answer({ value: 10522, unit: "USD" })), false);
  assert.equal(correct(MONEY, answer({ value: 10522 })), false);
});

test("a missing unit on a money golden says so in the evidence", () => {
  const evidence = assertionById(grade(MONEY, answer({ value: 10522 })), "answer_correct").evidence;
  assert.deepEqual(evidence, { want: "10522.00 THB ±0.01", got: "10522.00 (no unit)" });
});

test("a plain number is scored without a unit", () => {
  assert.equal(correct(NUMBER, answer({ value: 3750 })), true);
  assert.equal(correct(NUMBER, answer({ value: 3750, unit: "THB" })), true);
  assert.equal(correct(NUMBER, answer({ value: 3749 })), false);
  assert.deepEqual(assertionById(grade(NUMBER, answer({ value: 3750 })), "answer_correct").evidence, {
    want: "3750.00 ±0.01",
    got: "3750.00",
  });
});

test("a string answer is compared on its own line, trimmed and case-folded", () => {
  assert.equal(correct(STRING, { answer: "Grab" }), true);
  assert.equal(correct(STRING, { answer: "  grab  " }), true);
  assert.equal(correct(STRING, { answer: "Grab Food" }), false);
  assert.equal(correct(STRING, { answer: "The top merchant was Grab" }), false);
  assert.deepEqual(assertionById(grade(STRING, { answer: " grab " }), "answer_correct").evidence, {
    want: '"Grab"',
    got: '"grab"',
  });
});

test("a per-currency answer passes when both ledgers land and nothing is fused", () => {
  assert.equal(correct(SPLIT, answer({ perCurrency: { THB: 10522, USD: 50 } })), true);
  assert.equal(correct(SPLIT, answer({ perCurrency: { thb: 10522, usd: 50 } })), true);
  assert.equal(correct(SPLIT, answer({ perCurrency: { THB: 10522.01, USD: 49.99 } })), true);
});

test("the currency trap springs on a single fused total", () => {
  const sprung = grade(SPLIT, answer({ value: 10572, perCurrency: { THB: 10522, USD: 50 } }));
  assert.equal(assertionById(sprung, "answer_correct").passed, false);
  assert.deepEqual(assertionById(sprung, "answer_correct").evidence, {
    want: "THB 10522.00, USD 50.00, and no single fused total",
    got: "THB 10522.00, USD 50.00, fused into 10572.00",
  });
  assert.equal(sprung.passed, false);
  assert.equal(sprung.passRate, 0.5);
});

test("a per-currency answer fails on a missing, extra, or wrong ledger", () => {
  assert.equal(correct(SPLIT, answer({ perCurrency: { THB: 10522 } })), false);
  assert.equal(correct(SPLIT, answer({ perCurrency: { THB: 10522, USD: 50, EUR: 0 } })), false);
  assert.equal(correct(SPLIT, answer({ perCurrency: { THB: 10522, USD: 51 } })), false);
  assert.equal(correct(SPLIT, answer({ value: 10572 })), false);
});

test("a run that never submitted fails both claims and says which is missing", () => {
  const scored = grade(MONEY, null);
  assert.deepEqual(assertionById(scored, "submit_called").evidence, {
    want: "one submit_answer call",
    got: "the phase ended with no submit_answer call",
  });
  assert.deepEqual(assertionById(scored, "answer_correct").evidence, {
    want: "10522.00 THB ±0.01",
    got: "no answer submitted",
  });
  assert.equal(scored.passRate, 0);
  assert.equal(scored.passed, false);
});

test("a submitted answer with no number still counts as submitted", () => {
  const scored = grade(MONEY, { answer: "about ten thousand baht" });
  assert.equal(assertionById(scored, "submit_called").passed, true);
  assert.equal(assertionById(scored, "answer_correct").passed, false);
  assert.equal(assertionById(scored, "answer_correct").evidence.got, "no numeric value");
  assert.equal(scored.passRate, 0.5);
});
