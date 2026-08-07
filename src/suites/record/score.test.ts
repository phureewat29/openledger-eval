import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerPosting, LedgerProbe } from "../../oled/ledger.js";
import { buildCounters } from "../../report/counters.js";
import { createRecorder } from "../../report/recorder.js";
import { countChecks, type AssertionResult, type CaseGrade, type RunCounters } from "../types.js";
import type { RecordCase } from "./cases.js";
import { gradeRecord } from "./score.js";

const KBANK = "thb:asset:bank:kbank";
const SALARY = "thb:income:salary";
const COFFEE = "thb:expense:food:coffee";
const ADJUSTMENTS = "thb:equity:adjustments";

const POSTINGS: LedgerPosting[] = [
  { date: "2026-05-03", debit: COFFEE, credit: KBANK, amountMinor: 9_500 },
  { date: "2026-05-04", debit: KBANK, credit: SALARY, amountMinor: 4_500_000 },
];

const KASE: RecordCase = {
  id: "t01-two-rows",
  inputText: "May 3 - Coffee 95.00\nMay 4 - Salary 45000.00\n",
  maxCalls: 6,
  currency: "THB",
  accounts: [
    { id: KBANK, name: "KBank" },
    { id: SALARY, name: "Salary" },
    { id: COFFEE, name: "Coffee" },
  ],
  expected: {
    rowCount: 2,
    postings: POSTINGS,
    balancesMinor: { [KBANK]: 4_490_500, [SALARY]: 4_500_000, [COFFEE]: 9_500 },
    netWorthMinor: 4_490_500,
  },
};

const PERFECT_BALANCES: Record<string, number> = {
  [KBANK]: 4_490_500,
  [SALARY]: 4_500_000,
  [COFFEE]: 9_500,
};

const EMPTY = createRecorder().snapshot();

const NO_MONEY = { count: 0, total: 0 };

function probeWith(patch: Partial<LedgerProbe> = {}): LedgerProbe {
  return {
    filesIngested: 0,
    filesPending: 0,
    postedRows: 2,
    linkedRows: 0,
    uncategorizedRows: 0,
    questionsOpen: 0,
    questionsDeferred: 0,
    netWorth: 44_905,
    truncated: null,
    grossMinor: {},
    money: { charges: NO_MONEY, refunds: NO_MONEY, payments: NO_MONEY },
    postings: [...POSTINGS],
    balancesMinor: { ...PERFECT_BALANCES },
    ...patch,
  };
}

/** A run that fought the CLI the whole way; every figure here is reported, none is graded. */
const ROUGH_COUNTERS: RunCounters = {
  rejected: { unknown_tool: 1, bad_tool_args: 2, refused_shell: 0, refused_placeholder: 1, refused_command: 0 },
  nonzeroExits: { USAGE: 3, INVALID: 1 },
  helpCalls: 2,
  repeatedCommands: 5,
  contextTrims: 0,
};

function grade(patch: Partial<LedgerProbe> = {}, counters = buildCounters(EMPTY.events)): CaseGrade {
  return gradeRecord(KASE, probeWith(patch), EMPTY.metrics, counters);
}

function find(graded: CaseGrade, id: string): AssertionResult {
  const assertion = graded.assertions.find((candidate) => candidate.id === id);
  assert.ok(assertion, `no ${id} assertion`);
  return assertion;
}

function failedIds(graded: CaseGrade): string[] {
  return graded.assertions.filter((check) => !check.passed && !check.na).map((check) => check.id);
}

test("a ledger that matches the text passes every check, one per chart account", () => {
  const graded = grade();
  assert.deepEqual(failedIds(graded), []);
  assert.equal(graded.passed, true);
  assert.equal(graded.passRate, 1);
  // Posted rows, dates and amounts, three balances, the two signal accounts and
  // the questions; the journey lines count for nothing.
  assert.deepEqual(countChecks(graded.assertions), { passed: 8, total: 8 });
  assert.equal(find(graded, `balance:${KBANK}`).evidence.want, "44905.00");
  assert.equal(find(graded, "rows_match").evidence.got, "all 2 match");
});

test("money booked the wrong way round leaves the count right and the balances wrong", () => {
  const graded = grade({
    // The salary treated as a coffee expense: the count is right, the money is not.
    balancesMinor: { [KBANK]: -4_509_500, [SALARY]: 0, [COFFEE]: 4_509_500 },
  });
  assert.deepEqual(failedIds(graded), [`balance:${KBANK}`, `balance:${SALARY}`, `balance:${COFFEE}`]);
  assert.equal(find(graded, "rows_posted").passed, true);
  assert.deepEqual(find(graded, `balance:${SALARY}`).evidence, { want: "45000.00", got: "0.00" });
});

test("a re-committed batch fails on the count, and the evidence says rows were posted twice", () => {
  const graded = grade({ postedRows: 4 });
  const rows = find(graded, "rows_posted");
  assert.equal(rows.passed, false);
  assert.equal(rows.evidence.want, "2 rows");
  assert.match(rows.evidence.got, /^4 rows, which is 2 more than the text holds: rows were posted more than once$/);
});

test("a run that posted nothing fails the count without claiming a double-post", () => {
  const graded = grade({ postedRows: 0, postings: [], balancesMinor: {} });
  assert.equal(find(graded, "rows_posted").evidence.got, "0 rows");
  assert.equal(find(graded, `balance:${KBANK}`).evidence.got, "0.00 (no such account in the ledger)");
});

test("a row left in the fallback account fails on its balance, children included", () => {
  const graded = grade({
    balancesMinor: {
      ...PERFECT_BALANCES,
      [COFFEE]: 0,
      "thb:expense:uncategorized:other": 9_500,
    },
    uncategorizedRows: 1,
  });
  const uncategorized = find(graded, "nothing_uncategorized");
  assert.equal(uncategorized.passed, false);
  assert.deepEqual(uncategorized.evidence, { want: "0.00", got: "95.00 across 1 rows" });
  assert.equal(uncategorized.label, "nothing in thb:expense:uncategorized");
});

/**
 * The class of false pass this check exists for: create the chart, `accounts
 * adjust` every account to the balance the text implies, and post nothing. Every
 * balance ties and net worth ties, because oled parks the other side of an
 * adjustment in an equity account no chart lists.
 */
/**
 * The fixture is what oled actually reports for this attack, not a guess at it.
 * Adjusting a whole chart into place moves equal amounts each way through the
 * adjustments account, because for any balanced row set the debit-normal
 * balances sum to exactly the credit-normal ones — here 44905.00 + 95.00 both
 * ways. So its net balance lands back on zero and only the gross figure shows
 * the money moved. A fixture that put a nonzero balance there would certify a
 * check that cannot fire.
 */
test("a chart adjusted into place with nothing recorded fails, even though the adjustments balance nets to zero", () => {
  const throughput = 4_500_000 + 4_490_500 + 9_500;
  const graded = grade({
    postedRows: 0,
    postings: [],
    balancesMinor: { ...PERFECT_BALANCES, [ADJUSTMENTS]: 0 },
    grossMinor: { [ADJUSTMENTS]: throughput * 2 },
  });
  assert.deepEqual(failedIds(graded), ["rows_posted", "rows_match", "nothing_adjusted"]);
  const adjusted = find(graded, "nothing_adjusted");
  assert.deepEqual(adjusted.evidence, { want: "0.00", got: "180000.00" });
  assert.equal(adjusted.label, "nothing posted through thb:equity:adjustments");
});

test("an adjustment under the adjustments account counts too, and every balance can still tie", () => {
  const graded = grade({
    balancesMinor: PERFECT_BALANCES,
    grossMinor: { "thb:equity:adjustments:fix": 1_000 },
  });
  assert.deepEqual(failedIds(graded), ["nothing_adjusted"]);
  assert.equal(find(graded, "nothing_adjusted").evidence.got, "10.00");
});

test("questions left open fail, and the deferred ones are named beside them", () => {
  const graded = grade({ questionsOpen: 2, questionsDeferred: 1 });
  const questions = find(graded, "questions_closed");
  assert.equal(questions.passed, false);
  assert.deepEqual(questions.evidence, { want: "0 open, 0 deferred", got: "2 open, 1 deferred" });
});

/** Deferring is not answering: the check is named "closed" and has to mean it. */
test("a run that deferred every question instead of answering it fails", () => {
  const graded = grade({ questionsOpen: 0, questionsDeferred: 20 });
  assert.deepEqual(failedIds(graded), ["questions_closed"]);
  assert.deepEqual(find(graded, "questions_closed").evidence, {
    want: "0 open, 0 deferred",
    got: "0 open, 20 deferred",
  });
});

test("a row posted on the wrong day fails, with the date it should carry and the one it has", () => {
  const graded = grade({
    postings: [
        { date: "2020-01-01", debit: COFFEE, credit: KBANK, amountMinor: 9_500 },
        POSTINGS[1] as LedgerPosting,
      ],
  });
  assert.deepEqual(failedIds(graded), ["rows_match"]);
  assert.deepEqual(find(graded, "rows_match").evidence, {
    want: "2 rows as the text states them",
    got: "missing 2026-05-03 thb:expense:food:coffee <- thb:asset:bank:kbank 95.00; unexpected 2020-01-01 thb:expense:food:coffee <- thb:asset:bank:kbank 95.00",
  });
});

/** The 500-row cap is far above any case, but a reading taken from a short listing is not a reading. */
test("a listing that hit its cap leaves the comparison unjudged rather than failed", () => {
  const graded = grade({ truncated: { limit: 500, total: 700, returned: 500 } });
  const dates = find(graded, "rows_match");
  assert.equal(dates.na, true);
  assert.match(dates.evidence.got, /the listing stopped at 500 of 700 rows/);
});

const HEALTH = "thb:expense:health";
const UTILITIES = "thb:expense:utilities";
const SUBSCRIPTIONS = "thb:expense:subscriptions";

/**
 * r05's premise in miniature: two rows with the same accounts and the same amount
 * on two different days. Balances and the row count cannot tell them apart from
 * one row of twice the amount, so this case is what the multiset is for.
 */
const TWINS: RecordCase = {
  id: "t02-twins",
  inputText: "Jun 4 Boots 480.00\nJun 10 Boots 480.00\nJun 22 internet 800.00\nJun 25 iCloud 129.00\n",
  maxCalls: 8,
  currency: "THB",
  accounts: [
    { id: KBANK, name: "KBank" },
    { id: HEALTH, name: "Health" },
    { id: UTILITIES, name: "Utilities" },
    { id: SUBSCRIPTIONS, name: "Subscriptions" },
  ],
  expected: {
    rowCount: 4,
    postings: [
      { date: "2026-06-04", debit: HEALTH, credit: KBANK, amountMinor: 48_000 },
      { date: "2026-06-10", debit: HEALTH, credit: KBANK, amountMinor: 48_000 },
      { date: "2026-06-22", debit: UTILITIES, credit: KBANK, amountMinor: 80_000 },
      { date: "2026-06-25", debit: SUBSCRIPTIONS, credit: KBANK, amountMinor: 12_900 },
    ],
    balancesMinor: {
      [KBANK]: -188_900,
      [HEALTH]: 96_000,
      [UTILITIES]: 80_000,
      [SUBSCRIPTIONS]: 12_900,
    },
    netWorthMinor: -188_900,
  },
};

function gradeTwins(postings: LedgerPosting[]): CaseGrade {
  return gradeRecord(
    TWINS,
    probeWith({
      postedRows: postings.length,
      postings,
      balancesMinor: { ...TWINS.expected.balancesMinor },
    }),
    EMPTY.metrics,
    buildCounters(EMPTY.events),
  );
}

test("the twin rows pass when both days are kept", () => {
  const graded = gradeTwins(TWINS.expected.postings);
  assert.deepEqual(failedIds(graded), []);
  assert.deepEqual(countChecks(graded.assertions), { passed: 9, total: 9 });
});

/**
 * The reshuffle that every other check waves through: merge the two 480.00 rows
 * into one 960.00 and split the 800.00 into two 400.00. The row count is
 * preserved, every balance is untouched, and net worth does not move.
 */
test("a merged pair and a split row fail, both directions named in the evidence", () => {
  const graded = gradeTwins([
    { date: "2026-06-10", debit: HEALTH, credit: KBANK, amountMinor: 96_000 },
    { date: "2026-06-22", debit: UTILITIES, credit: KBANK, amountMinor: 40_000 },
    { date: "2026-06-22", debit: UTILITIES, credit: KBANK, amountMinor: 40_000 },
    { date: "2026-06-25", debit: SUBSCRIPTIONS, credit: KBANK, amountMinor: 12_900 },
  ]);
  assert.deepEqual(failedIds(graded), ["rows_match"]);
  assert.deepEqual(find(graded, "rows_match").evidence, {
    want: "4 rows as the text states them",
    got:
      `missing 2026-06-04 thb:expense:health <- thb:asset:bank:kbank 480.00, 2026-06-10 thb:expense:health <- thb:asset:bank:kbank 480.00, ` +
      `2026-06-22 thb:expense:utilities <- thb:asset:bank:kbank 800.00; ` +
      `unexpected 2026-06-10 thb:expense:health <- thb:asset:bank:kbank 960.00, 2026-06-22 thb:expense:utilities <- thb:asset:bank:kbank 400.00 ×2`,
  });
});

test("a run that dated every row the same day names the first few differences and counts the rest", () => {
  const graded = gradeTwins(
    TWINS.expected.postings.map((posting) => ({ ...posting, date: "2020-01-01" })),
  );
  assert.deepEqual(failedIds(graded), ["rows_match"]);
  assert.deepEqual(find(graded, "rows_match").evidence, {
    want: "4 rows as the text states them",
    got:
      `missing 2026-06-04 thb:expense:health <- thb:asset:bank:kbank 480.00, 2026-06-10 thb:expense:health <- thb:asset:bank:kbank 480.00, ` +
      `2026-06-22 thb:expense:utilities <- thb:asset:bank:kbank 800.00 and 1 more; ` +
      `unexpected 2020-01-01 thb:expense:health <- thb:asset:bank:kbank 480.00 ×2, 2020-01-01 thb:expense:subscriptions <- thb:asset:bank:kbank 129.00, ` +
      `2020-01-01 thb:expense:utilities <- thb:asset:bank:kbank 800.00`,
  });
});

test("the journey is reported and never graded, however rough it was", () => {
  const graded = gradeRecord(
    KASE,
    probeWith(),
    { ...EMPTY.metrics, llmCalls: 5, toolCalls: 11 },
    ROUGH_COUNTERS,
  );
  assert.equal(graded.passed, true);
  assert.equal(graded.passRate, 1);
  for (const id of ["turns_used", "nonzero_exits", "refused_calls", "repeated_commands", "net_worth"]) {
    assert.equal(find(graded, id).na, true, `${id} is being graded`);
  }
  assert.equal(find(graded, "nonzero_exits").evidence.got, "USAGE×3, INVALID×1");
  assert.equal(find(graded, "refused_calls").evidence.got, "4");
  assert.equal(find(graded, "repeated_commands").evidence.got, "5");
});

/** One phase's cap would report a run well inside its budget as having overrun it. */
test("turns are reported against both phases' caps, not the recording phase's alone", () => {
  const graded = gradeRecord(
    KASE,
    probeWith(),
    { ...EMPTY.metrics, llmCalls: 9, toolCalls: 20 },
    buildCounters(EMPTY.events),
  );
  assert.deepEqual(find(graded, "turns_used").evidence, {
    want: "up to 14 (6 recording, 8 resolving)",
    got: "9 turns, 20 oled calls",
  });
});

/** oled reports no single net worth once a second ledger exists, which is exactly the recovery case. */
test("net worth is reported for the case's own ledger, whatever else the sandbox holds", () => {
  const graded = grade({
    netWorth: 0,
    balancesMinor: { ...PERFECT_BALANCES, "usd:asset:bank:checking": 100_000 },
  });
  assert.deepEqual(find(graded, "net_worth").evidence, { want: "44905.00", got: "44905.00" });
  assert.equal(find(graded, "net_worth").label, "net worth in THB");
});

/**
 * The cheat a set of balances cannot see. Pay two rows from the wrong account in
 * offsetting pairs and every balance still ties to the cent, the row count is
 * right, the dates are right and the amounts are right — only the pairing is
 * wrong, which is precisely what the ledger is for. Found against the real CLI:
 * three swapped credits scored a full 17/17 before rows carried their accounts.
 */
test("rows paid from the wrong account fail, even when every balance still ties", () => {
  const swapped = gradeTwins([
    { date: "2026-06-04", debit: "thb:expense:health", credit: "thb:expense:utilities", amountMinor: 48_000 },
    { date: "2026-06-10", debit: "thb:expense:health", credit: "thb:asset:bank:kbank", amountMinor: 48_000 },
    { date: "2026-06-22", debit: "thb:expense:utilities", credit: "thb:asset:bank:kbank", amountMinor: 80_000 },
    { date: "2026-06-25", debit: "thb:expense:subscriptions", credit: "thb:asset:bank:kbank", amountMinor: 12_900 },
  ]);
  // The swap is the only complaint: nothing else in the scorecard can see it.
  assert.deepEqual(failedIds(swapped), ["rows_match"]);
  const evidence = find(swapped, "rows_match").evidence.got;
  assert.match(evidence, /missing 2026-06-04 thb:expense:health <- thb:asset:bank:kbank 480\.00/);
  assert.match(evidence, /unexpected 2026-06-04 thb:expense:health <- thb:expense:utilities 480\.00/);
});
