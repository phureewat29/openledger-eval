import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerProbe } from "../../oled/ledger.js";
import type { AssertionResult, CaseGrade } from "../types.js";
import { gradeIngest } from "./score.js";
import { expectedNetWorth, type StatementFacts } from "./truth.js";

const FACTS: StatementFacts = {
  statement: "card-statement-2026-05.pdf",
  note: "fabricated for this test",
  currency: "THB",
  groups: {
    charges: { count: 120, total: 88412.96 },
    refunds: { count: 5, total: 3574.5 },
    payments: { count: 1, total: 31195.16 },
  },
  summary: {
    previousBalance: 31195.16,
    purchasesAndFees: 88412.96,
    refundsAndCredits: 3574.5,
    paymentsReceived: 31195.16,
    totalAmountDue: 84838.46,
  },
};

const PERFECT: LedgerProbe = {
  filesIngested: 1,
  filesPending: 0,
  postedRows: 126,
  uncategorizedRows: 0,
  questionsOpen: 0,
  questionsDeferred: 0,
  netWorth: -116033.62,
  truncated: null,
  postings: [],
  money: {
    charges: { count: 120, total: 88412.96 },
    refunds: { count: 5, total: 3574.5 },
    payments: { count: 1, total: 31195.16 },
  },
  // Empty because gradeIngest scores the statement's groups, not per-account balances.
  balancesMinor: {},
  grossMinor: {},
};

function probeWith(patch: Partial<LedgerProbe>): LedgerProbe {
  return { ...PERFECT, ...patch };
}

function moneyWith(patch: Partial<LedgerProbe["money"]>): LedgerProbe {
  return probeWith({ money: { ...PERFECT.money, ...patch } });
}

function failedIds(grade: CaseGrade): string[] {
  return grade.assertions.filter((check) => !check.passed && !check.na).map((check) => check.id);
}

function assertionById(grade: CaseGrade, id: string): AssertionResult {
  const found = grade.assertions.find((check) => check.id === id);
  assert.ok(found, `no assertion ${id}`);
  return found;
}

test("passes every check on a ledger that matches the statement", () => {
  const grade = gradeIngest("card-statement-2026-05", FACTS, PERFECT);
  assert.equal(grade.caseId, "card-statement-2026-05");
  assert.equal(grade.assertions.length, 13);
  assert.deepEqual(failedIds(grade), []);
  assert.equal(grade.passRate, 1);
  assert.equal(grade.passed, true);
});

test("reads every check back with evidence a person can compare", () => {
  const grade = gradeIngest("case", FACTS, PERFECT);
  assert.deepEqual(assertionById(grade, "charges_total").evidence, {
    want: "88412.96 ±0.01",
    got: "88412.96",
  });
  assert.deepEqual(assertionById(grade, "net_worth").evidence, {
    want: "-116033.62 ±1.00",
    got: "-116033.62",
  });
  assert.deepEqual(assertionById(grade, "uncategorized_ratio").evidence, {
    want: "≤ 5.0%",
    got: "0.0% (0 of 126)",
  });
  assert.deepEqual(assertionById(grade, "unclassified_rows").evidence, {
    want: "not applicable",
    got: "0 of 126, usually the opening balance (booked through equity, which groupOf assigns to no group)",
  });
});

test("net worth carries the statement's previous balance", () => {
  const noOpeningBalance: StatementFacts = {
    ...FACTS,
    summary: { ...FACTS.summary, previousBalance: 0 },
  };
  assert.equal(expectedNetWorth(noOpeningBalance), -84838.46);
  assert.equal(expectedNetWorth(FACTS), -116033.62);
});

const FAILURES: { name: string; probe: LedgerProbe; failing: string[] }[] = [
  {
    name: "a charge that never posted",
    probe: moneyWith({ charges: { count: 119, total: 88412.96 } }),
    failing: ["rows_posted", "charges_count"],
  },
  {
    name: "a charge total two cents short",
    probe: moneyWith({ charges: { count: 120, total: 88412.94 } }),
    failing: ["charges_total"],
  },
  {
    name: "a refund posted twice",
    probe: moneyWith({ refunds: { count: 6, total: 3574.5 } }),
    failing: ["rows_posted", "refunds_count"],
  },
  {
    name: "a refund total off",
    probe: moneyWith({ refunds: { count: 5, total: 3570 } }),
    failing: ["refunds_total"],
  },
  {
    name: "a missing payment",
    probe: moneyWith({ payments: { count: 0, total: 31195.16 } }),
    failing: ["rows_posted", "payments_count"],
  },
  {
    name: "a payment total off",
    probe: moneyWith({ payments: { count: 1, total: 31195.2 } }),
    failing: ["payments_total"],
  },
  {
    name: "more than a twentieth of the rows left uncategorized",
    probe: probeWith({ uncategorizedRows: 7 }),
    failing: ["uncategorized_ratio"],
  },
  {
    name: "a question left open",
    probe: probeWith({ questionsOpen: 2 }),
    failing: ["questions_closed"],
  },
  {
    // `questions defer` would otherwise close this check without answering anything.
    name: "every question deferred rather than answered",
    probe: probeWith({ questionsOpen: 0, questionsDeferred: 12 }),
    failing: ["questions_closed"],
  },
  {
    name: "no file ingested",
    probe: probeWith({ filesIngested: 0 }),
    failing: ["file_ingested"],
  },
  {
    name: "a file left pending",
    probe: probeWith({ filesPending: 1 }),
    failing: ["file_closed"],
  },
  {
    name: "net worth off by more than a baht",
    probe: probeWith({ netWorth: -116031.62 }),
    failing: ["net_worth"],
  },
];

for (const scenario of FAILURES) {
  test(`fails on ${scenario.name}`, () => {
    const grade = gradeIngest("case", FACTS, scenario.probe);
    assert.deepEqual(failedIds(grade), scenario.failing);
    assert.equal(grade.passed, false);
    assert.equal(grade.passRate, (12 - scenario.failing.length) / 12);
  });
}

test("holds the line at the tolerance itself", () => {
  const onTolerance = {
    ...moneyWith({ charges: { count: 120, total: 88412.95 } }),
    netWorth: -116032.62,
    postedRows: 100,
    uncategorizedRows: 5,
  };
  assert.deepEqual(failedIds(gradeIngest("case", FACTS, onTolerance)), []);
});

test("reports rows the statement's groups can't see, naming the opening balance", () => {
  // 127 posted against 126 grouped: the one row `groupOf` (ledger.ts) never assigns
  // a group, same as a real ledger with its opening balance booked through equity.
  const withOpeningBalance = probeWith({ postedRows: 127 });
  const grade = gradeIngest("case", FACTS, withOpeningBalance);
  const unclassified = assertionById(grade, "unclassified_rows");
  assert.equal(unclassified.na, true);
  assert.deepEqual(unclassified.evidence, {
    want: "not applicable",
    got: "1 of 127, usually the opening balance (booked through equity, which groupOf assigns to no group)",
  });
  // reported, not scored: it changes nothing about pass/fail.
  assert.deepEqual(failedIds(grade), []);
  assert.equal(grade.passed, true);
});

test("scores no ratio when no rows posted, and counts it in neither column", () => {
  const empty = {
    ...moneyWith({
      charges: { count: 0, total: 0 },
      refunds: { count: 0, total: 0 },
      payments: { count: 0, total: 0 },
    }),
    filesIngested: 0,
    postedRows: 0,
    netWorth: 0,
  };
  const grade = gradeIngest("case", FACTS, empty);
  const ratio = assertionById(grade, "uncategorized_ratio");
  assert.equal(ratio.na, true);
  assert.deepEqual(ratio.evidence, { want: "not applicable", got: "no rows posted" });
  // questions_closed and file_closed are the only ones an empty ledger satisfies.
  assert.equal(grade.passRate, 2 / 11);
  assert.equal(grade.passed, false);
});

test("says why a total came back zero when the rows span two currency ledgers", () => {
  const twoLedgers = moneyWith({
    charges: { count: 120, total: 0 },
    refunds: { count: 5, total: 0 },
    payments: { count: 1, total: 0 },
  });
  const grade = gradeIngest("case", FACTS, twoLedgers);
  assert.deepEqual(failedIds(grade), ["charges_total", "refunds_total", "payments_total"]);
  assert.equal(
    assertionById(grade, "charges_total").evidence.got,
    "0.00 (no single-currency total: the rows span more than one ledger)",
  );
});
