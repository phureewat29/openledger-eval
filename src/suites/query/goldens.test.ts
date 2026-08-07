import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANSWER_EXPECTATION,
  derive,
  expectationGap,
  loadQueryCases,
  selfCheck,
  type Derivation,
  type QueryCase,
} from "./goldens.js";
import type { SeedRow } from "./rows.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));

function loadCases(): QueryCase[] {
  const cases = loadQueryCases(FIXTURES);
  assert.ok(cases.ok, cases.ok ? "" : cases.error);
  return cases.value;
}

test("every checked-in question agrees with the rows its own sandbox would hold", () => {
  const cases = loadCases();
  assert.equal(cases.length, 12);
  assert.deepEqual(
    cases.map((kase) => kase.id),
    ["q01", "q02", "q03", "q04", "q05", "q06", "q07", "q08", "q09", "q10", "q11", "q12"],
  );
  for (const kase of cases) assert.equal(selfCheck(kase), null, `${kase.id} disagrees`);
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
  const cases = loadQueryCases("/nonexistent/fixtures");
  assert.equal(cases.ok, false);
});

const ROWS: SeedRow[] = [
  {
    date: "2026-04-25",
    description: "April coffee",
    debit_account: "thb:expense:food:coffee",
    credit_account: "thb:asset:bank:kbank",
    amount: 120,
    merchant: { canonical_name: "Roots" },
  },
  {
    date: "2026-05-02",
    description: "May coffee",
    debit_account: "thb:expense:food:coffee",
    credit_account: "thb:asset:bank:kbank",
    amount: 80.5,
    merchant: { canonical_name: "Roots" },
  },
  {
    date: "2026-05-09",
    description: "May lunch on the card",
    debit_account: "thb:expense:food:restaurants",
    credit_account: "thb:liability:card:visa",
    amount: 300,
    merchant: { canonical_name: "Grab" },
  },
  {
    date: "2026-05-20",
    description: "Salary",
    debit_account: "thb:asset:bank:kbank",
    credit_account: "thb:income:salary",
    amount: 1000,
  },
  {
    date: "2026-05-21",
    description: "Editor seat",
    debit_account: "usd:expense:software",
    credit_account: "usd:asset:bank:wise",
    amount: 12,
    merchant: { canonical_name: "GitHub" },
  },
];

const MAY = { from: "2026-05-01", to: "2026-05-31" };

function derived(derivation: Derivation): unknown {
  const result = derive(ROWS, derivation);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.value;
}

test("count reads every filter, and an empty filter counts the ledger", () => {
  assert.deepEqual(derived({ op: "count", where: {} }), { kind: "number", value: 5 });
  assert.deepEqual(derived({ op: "count", where: MAY }), { kind: "number", value: 4 });
  assert.deepEqual(
    derived({ op: "count", where: { debit: ["thb:expense:food:coffee"], ...MAY } }),
    { kind: "number", value: 1 },
  );
  assert.deepEqual(derived({ op: "count", where: { credit: ["thb:income:salary"] } }), {
    kind: "number",
    value: 1,
  });
  assert.deepEqual(derived({ op: "count", where: { merchant: "Roots" } }), {
    kind: "number",
    value: 2,
  });
  assert.deepEqual(derived({ op: "count", where: { debitType: "expense", currency: "USD" } }), {
    kind: "number",
    value: 1,
  });
});

test("amountOver is strict, so a row exactly on the threshold does not count", () => {
  const where = { debit: ["thb:expense:food:coffee"] };
  assert.deepEqual(derived({ op: "count", where: { ...where, amountOver: 80.5 } }), {
    kind: "number",
    value: 1,
  });
  assert.deepEqual(derived({ op: "count", where: { ...where, amountOver: 80.49 } }), {
    kind: "number",
    value: 2,
  });
});

test("sum adds the matching rows in minor units", () => {
  assert.deepEqual(derived({ op: "sum", where: { debitType: "expense", currency: "THB", ...MAY } }), {
    kind: "number",
    value: 380.5,
  });
  assert.deepEqual(derived({ op: "sum", where: { merchant: "Grab" } }), {
    kind: "number",
    value: 300,
  });
});

test("balance takes the account's own normal side", () => {
  assert.deepEqual(derived({ op: "balance", account: "thb:asset:bank:kbank" }), {
    kind: "number",
    value: 799.5,
  });
  assert.deepEqual(derived({ op: "balance", account: "thb:liability:card:visa" }), {
    kind: "number",
    value: 300,
  });
  assert.deepEqual(derived({ op: "balance", account: "thb:income:salary" }), {
    kind: "number",
    value: 1000,
  });
  assert.deepEqual(derived({ op: "balance", account: "thb:expense:food:coffee" }), {
    kind: "number",
    value: 200.5,
  });
});

test("balance refuses an id that names no account type", () => {
  const result = derive(ROWS, { op: "balance", account: "kbank" });
  assert.equal(result.ok, false);
});

test("net worth is one ledger's assets less its liabilities", () => {
  assert.deepEqual(derived({ op: "net_worth", currency: "THB" }), {
    kind: "number",
    value: 499.5,
  });
  assert.deepEqual(derived({ op: "net_worth", currency: "USD" }), { kind: "number", value: -12 });
});

test("net worth refuses a ledger no row touches", () => {
  const result = derive(ROWS, { op: "net_worth", currency: "EUR" });
  assert.equal(result.ok, false);
});

test("top merchant ranks by total, not by row count", () => {
  assert.deepEqual(derived({ op: "top_merchant", where: { debitType: "expense", currency: "THB" } }), {
    kind: "string",
    value: "Grab",
  });
});

test("top merchant refuses a tie rather than picking a side", () => {
  const tied: SeedRow[] = [
    { ...ROWS[1]!, amount: 300, merchant: { canonical_name: "Roots" } },
    ROWS[2]!,
  ];
  const result = derive(tied, { op: "top_merchant", where: {} });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /tie/);
});

test("top merchant refuses a window whose rows name no merchant", () => {
  const result = derive(ROWS, { op: "top_merchant", where: { credit: ["thb:income:salary"] } });
  assert.equal(result.ok, false);
});

test("delta subtracts the second window from the first", () => {
  const food = ["thb:expense:food:coffee", "thb:expense:food:restaurants"];
  assert.deepEqual(
    derived({
      op: "delta",
      of: { debit: food, ...MAY },
      minus: { debit: food, from: "2026-04-01", to: "2026-04-30" },
    }),
    { kind: "number", value: 260.5 },
  );
});

test("per-currency sum keeps the ledgers apart", () => {
  assert.deepEqual(derived({ op: "per_currency_sum", where: { debitType: "expense", ...MAY } }), {
    kind: "perCurrency",
    value: { THB: 380.5, USD: 12 },
  });
});

test("per-currency sum refuses a window with no rows", () => {
  const result = derive(ROWS, { op: "per_currency_sum", where: { from: "2027-01-01" } });
  assert.equal(result.ok, false);
});

const CORRUPTED: QueryCase = {
  id: "q99",
  prompt: "How much did I spend on coffee in May 2026?",
  golden: { kind: "money", value: 99.99, unit: "THB" },
  derivation: { op: "sum", where: { debit: ["thb:expense:food:coffee"], ...MAY } },
  rows: ROWS,
};

test("a golden the rows do not support fails the self-check, naming both numbers", () => {
  const disagreement = selfCheck(CORRUPTED);
  assert.ok(disagreement);
  assert.match(disagreement, /^q99: /);
  assert.match(disagreement, /99\.99 THB/);
  assert.match(disagreement, /80\.50/);
});

test("a golden of the wrong shape fails the self-check too", () => {
  const mismatched = selfCheck({
    ...CORRUPTED,
    golden: { kind: "string", value: "Roots" },
  });
  assert.ok(mismatched);
  assert.match(mismatched, /"Roots"/);
});

test("a derivation that cannot run fails the self-check with its own reason", () => {
  const broken = selfCheck({
    ...CORRUPTED,
    derivation: { op: "net_worth", currency: "EUR" },
  });
  assert.ok(broken);
  assert.match(broken, /derivation failed/);
});

/**
 * q09 was scored wrong because nothing told the model that `answer` had to be
 * the merchant name alone: the only instruction it had asked for "a one-line
 * summary", so it wrote one, and the exact-match scorer refused it. Every
 * question now carries the sentence its own golden kind calls for.
 */
test("every checked-in question says which field its answer belongs in", () => {
  for (const kase of loadCases()) {
    const wanted = ANSWER_EXPECTATION[kase.golden.kind];
    if (wanted === null) continue;
    assert.ok(kase.prompt.includes(wanted), `${kase.id} does not carry ${JSON.stringify(wanted)}`);
  }
});

test("a question whose golden kind moved away from its prompt refuses to load", () => {
  const gap = expectationGap({
    id: "q99",
    prompt: "Which merchant did I spend the most at?",
    golden: { kind: "string", value: "Grab" },
  });
  assert.ok(gap);
  assert.match(gap, /q99 \(string\)/);
});

test("a question that already states its expectation has no gap", () => {
  const stated = expectationGap({
    id: "q99",
    prompt: `Which merchant? ${ANSWER_EXPECTATION.string ?? ""}`,
    golden: { kind: "string", value: "Grab" },
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
    golden: { kind: "per_currency", perCurrency: { THB: 100 } },
  });
  assert.equal(gap, null);
});
