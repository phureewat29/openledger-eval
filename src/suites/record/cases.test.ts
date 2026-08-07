import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Result } from "../../core/result.js";
import { loadRecordCases, type RecordCase } from "./cases.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures", import.meta.url));

const INPUT = `Spending, May 2026

May 3 - Coffee at Amazon, 95.00, KBank card
May 4 - Salary from Zentry, 45000.00, into KBank
`;

/** Two rows, one out and one in, so a sign error shows up in the derived balances. */
function caseJson(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t01-two-rows",
    input: "t01-two-rows.txt",
    maxCalls: 6,
    currency: "THB",
    needsLedger: null,
    accounts: [
      { id: "thb:asset:bank:kbank", name: "KBank" },
      { id: "thb:income:salary", name: "Salary" },
      { id: "thb:expense:food:coffee", name: "Coffee" },
    ],
    rows: [
      {
        date: "2026-05-03",
        description: "Coffee at Amazon",
        debit: "thb:expense:food:coffee",
        credit: "thb:asset:bank:kbank",
        amount: 95,
      },
      {
        date: "2026-05-04",
        description: "Salary from Zentry",
        debit: "thb:asset:bank:kbank",
        credit: "thb:income:salary",
        amount: 45000,
      },
    ],
    ...patch,
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "oled-eval-record-"));
}

function put(root: string, name: string, text: string): string {
  const dir = join(root, "record");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return dir;
}

/** One case written to a throwaway fixtures tree and loaded from it, as a run would. */
function loadOne(fixture: Record<string, unknown>, inputText = INPUT): Result<RecordCase[]> {
  const root = scratch();
  try {
    put(root, `${String(fixture.id)}.json`, JSON.stringify(fixture));
    put(root, String(fixture.input), inputText);
    return loadRecordCases(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function errorOf(loaded: Result<RecordCase[]>): string {
  assert.equal(loaded.ok, false, "the load should have failed");
  return loaded.ok ? "" : loaded.error;
}

test("every checked-in case loads, self-checked against its own input text", () => {
  const cases = loadRecordCases(FIXTURES);
  assert.ok(cases.ok, cases.ok ? "" : cases.error);
  assert.deepEqual(
    cases.value.map((kase) => kase.id),
    ["r01-markdown", "r02-note", "r03-csv", "r04-usd-recovery", "r05-messy"],
  );
  for (const kase of cases.value) {
    assert.ok(kase.inputText.trim().length > 0, `${kase.id} carries no input text`);
    assert.ok(kase.expected.rowCount > 0);
    assert.equal(Object.keys(kase.expected.balancesMinor).length, kase.accounts.length);
  }
});

/**
 * The cap counts model turns, and batch account creation needs a filesystem the
 * harness does not hand over, so a chart costs one turn per account. A cap at or
 * below the account count leaves nothing to spend on rows.
 */
test("every case can afford its own chart, and the CSV case still cannot post one row per turn", () => {
  const loaded = loadRecordCases(FIXTURES);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  assert.deepEqual(
    Object.fromEntries(loaded.value.map((kase) => [kase.id, kase.maxCalls])),
    {
      "r01-markdown": 32,
      "r02-note": 28,
      "r03-csv": 30,
      "r04-usd-recovery": 24,
      "r05-messy": 26,
    },
  );
  for (const kase of loaded.value) {
    assert.ok(kase.maxCalls > kase.accounts.length, `${kase.id} cannot afford its own chart`);
  }

  const csv = loaded.value.find((kase) => kase.id === "r03-csv");
  assert.ok(csv);
  assert.ok(csv.expected.rowCount > csv.maxCalls, "r03 no longer forces the rows into batches");
});

test("the expected ledger is derived from the rows, in minor units", () => {
  const loaded = loadOne(caseJson());
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);

  const kase = loaded.value[0];
  assert.ok(kase);
  assert.equal(kase.maxCalls, 6);
  assert.equal(kase.expected.rowCount, 2);
  assert.deepEqual(kase.expected.postings, [
    { date: "2026-05-03", debit: "thb:expense:food:coffee", credit: "thb:asset:bank:kbank", amountMinor: 9_500 },
    { date: "2026-05-04", debit: "thb:asset:bank:kbank", credit: "thb:income:salary", amountMinor: 4_500_000 },
  ]);
  assert.deepEqual(kase.expected.balancesMinor, {
    // Debit-normal: 45000.00 in less the 95.00 spent.
    "thb:asset:bank:kbank": 4_490_500,
    // Credit-normal, so the money in reads positive rather than negative.
    "thb:income:salary": 4_500_000,
    "thb:expense:food:coffee": 9_500,
  });
  assert.equal(kase.expected.netWorthMinor, 4_490_500);
});

/** The rows are the answers; carrying them past the load would put them one field away from a prompt. */
test("a loaded case carries the input and the expectation, never the canonical rows", () => {
  const loaded = loadOne(caseJson());
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  const kase = loaded.value[0];
  assert.ok(kase);
  assert.ok(!("rows" in kase), "the canonical rows are still on the case");
});

test("a row that names an account off the chart fails the load", () => {
  const rows = caseJson().rows as Record<string, unknown>[];
  const bent = [rows[0], { ...rows[1], credit: "thb:income:bonus" }];
  const message = errorOf(loadOne(caseJson({ rows: bent })));
  assert.match(message, /t01-two-rows/);
  assert.match(message, /credits thb:income:bonus, which the chart does not carry/);
});

test("an amount the input text never states fails the load", () => {
  const rows = caseJson().rows as Record<string, unknown>[];
  const bent = [{ ...rows[0], amount: 96 }, rows[1]];
  const message = errorOf(loadOne(caseJson({ rows: bent })));
  assert.match(message, /t01-two-rows: row 1: 96\.00 never appears in t01-two-rows\.txt/);
});

/** A bare substring finds 45.00 inside 145.00 and reports a missing amount as stated. */
test("an amount that appears only inside a longer number fails the load", () => {
  const rows = caseJson().rows as Record<string, unknown>[];
  const bent = [{ ...rows[0], amount: 45 }, rows[1]];
  const text = "May 3 - Coffee at Amazon, 145.00, KBank card\nMay 4 - Salary from Zentry, 45000.00, into KBank\n";
  const message = errorOf(loadOne(caseJson({ rows: bent }), text));
  assert.match(message, /row 1: 45\.00 never appears in t01-two-rows\.txt/);
});

/** Occurrences are counted, not looked up: the text states one 95.00 and two rows want it. */
test("a row written down twice fails the load, both row numbers named", () => {
  const rows = caseJson().rows as Record<string, unknown>[];
  const bent = [rows[0], { ...rows[0], date: "2026-05-06" }, rows[1]];
  const message = errorOf(loadOne(caseJson({ rows: bent })));
  assert.match(message, /rows 1, 2: 95\.00 appears 1× in t01-two-rows\.txt but 2 rows use it/);
});

test("a case that aims at the uncategorized account fails the load", () => {
  const base = caseJson();
  const accounts = [
    ...(base.accounts as unknown[]),
    { id: "thb:expense:uncategorized", name: "Uncategorized" },
  ];
  const rows = base.rows as Record<string, unknown>[];
  const bent = [{ ...rows[0], debit: "thb:expense:uncategorized" }, rows[1]];
  const message = errorOf(loadOne(caseJson({ accounts, rows: bent })));
  assert.match(message, /the chart carries thb:expense:uncategorized, which the harness reads as a failure/);
  assert.match(message, /row 1 .* debits thb:expense:uncategorized, which the harness reads as a failure/);
});

/** The scorecard reads money here as a balance forced by hand, so a fixture may not aim at it either. */
test("a case that aims at the adjustments account fails the load", () => {
  const base = caseJson();
  const accounts = [
    ...(base.accounts as unknown[]),
    { id: "thb:equity:adjustments", name: "Adjustments" },
  ];
  const rows = base.rows as Record<string, unknown>[];
  const bent = [{ ...rows[0], credit: "thb:equity:adjustments" }, rows[1]];
  const message = errorOf(loadOne(caseJson({ accounts, rows: bent })));
  assert.match(message, /the chart carries thb:equity:adjustments, which the harness reads as a failure/);
  assert.match(message, /row 1 .* credits thb:equity:adjustments, which the harness reads as a failure/);
});

test("a row that moves nothing fails the load", () => {
  const rows = caseJson().rows as Record<string, unknown>[];
  const bent = [{ ...rows[0], debit: "thb:asset:bank:kbank" }, rows[1]];
  const message = errorOf(loadOne(caseJson({ rows: bent })));
  assert.match(message, /debits and credits thb:asset:bank:kbank, so it moves nothing/);
});

/** THB is open from the start, so a declaration about it is a fixture that misreads its own sandbox. */
test("a needsLedger the sandbox already opened fails the load", () => {
  const message = errorOf(loadOne(caseJson({ needsLedger: "usd" })));
  assert.match(message, /needsLedger says usd, but the thb ledger is open from the start/);
});

test("a case in a currency the sandbox has no ledger for must declare it", () => {
  const usd = caseJson({
    id: "t02-usd",
    input: "t02-usd.txt",
    currency: "USD",
    needsLedger: null,
    accounts: [
      { id: "usd:asset:bank:checking", name: "Checking" },
      { id: "usd:expense:software", name: "Software" },
    ],
    rows: [
      {
        date: "2026-05-03",
        description: "Figma",
        debit: "usd:expense:software",
        credit: "usd:asset:bank:checking",
        amount: 95,
      },
    ],
  });
  const message = errorOf(loadOne(usd));
  assert.match(message, /a USD case must declare needsLedger usd, not null/);
});

test("an id that disagrees with its filename fails the load", () => {
  const root = scratch();
  try {
    put(root, "not-the-id.json", JSON.stringify(caseJson()));
    put(root, "t01-two-rows.txt", INPUT);
    assert.match(errorOf(loadRecordCases(root)), /calls itself t01-two-rows, so it is not one case per file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an id outside the account grammar fails the load", () => {
  const accounts = [{ id: "THB:asset:bank:kbank", name: "KBank" }, ...(caseJson().accounts as unknown[])];
  assert.match(errorOf(loadOne(caseJson({ accounts }))), /an account id is <ccy>:<type>/);
});

test("a directory with no case files, and one that is not there at all, both report it", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "record"), { recursive: true });
    assert.match(errorOf(loadRecordCases(root)), /holds no case files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(errorOf(loadRecordCases("/nonexistent/fixtures")), /cannot read/);
});
