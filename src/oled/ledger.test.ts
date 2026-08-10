import assert from "node:assert/strict";
import { test } from "node:test";
import { minorUnits } from "../core/money.js";
import type { OpenLedgerRunner } from "./command.js";
import { probeLedger, readBalances, tallyMoney } from "./ledger.js";

function row(debit: string, credit: string, amount: number, date = "2026-05-01") {
  return { date, debit_account_id: debit, credit_account_id: credit, amount };
}

const CHARGE = row("thb:expense:food", "thb:liability:card:ktc", 250.5);
const REFUND = row("thb:liability:card:ktc", "thb:expense:food", 50.25);
const PAYMENT = row("thb:liability:card:ktc", "thb:asset:bank:kbank", 1000);

test("groups by direction and totals one ledger exactly", () => {
  const money = tallyMoney([CHARGE, CHARGE, REFUND, PAYMENT]);
  assert.deepEqual(money, {
    charges: { count: 2, total: 501 },
    refunds: { count: 1, total: 50.25 },
    payments: { count: 1, total: 1000 },
  });
});

test("ignores a row that belongs to no group", () => {
  const opening = row("thb:asset:bank:kbank", "thb:equity:openingbalance", 5000);
  assert.deepEqual(tallyMoney([CHARGE, opening]).charges, { count: 1, total: 250.5 });
});

test("reports no total once a second ledger is in the tally, and keeps the counts", () => {
  const yenCharge = row("jpy:expense:food", "jpy:liability:card:jcb", 1500);
  const money = tallyMoney([CHARGE, yenCharge, PAYMENT]);
  // 250.50 baht + 1500 yen is not 1750.50 of anything.
  assert.deepEqual(money.charges, { count: 2, total: 0 });
  assert.deepEqual(money.payments, { count: 1, total: 0 });
});

/** One `accounts list --json` line, as oled writes it: signed decimal `balance`. */
function accountLine(id: string, type: string, balance: number, gross?: { debits: number; credits: number }): string {
  return JSON.stringify({
    id,
    name: id.split(":").at(-1),
    type,
    parent_id: null,
    currency: id.slice(0, 3).toUpperCase(),
    balance,
    debits_posted: gross?.debits ?? Math.abs(balance),
    credits_posted: gross?.credits ?? 0,
  });
}

function summaryLine(returned: number): string {
  return JSON.stringify({ type: "summary", total: returned, returned });
}

function listing(...accounts: string[]): Record<string, unknown>[] {
  return [...accounts, summaryLine(accounts.length)].map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

const STATUS_LINE = JSON.stringify({
  db: { reachable: true, error: null },
  counts: { transactions: 1 },
  files: { ingested: 1, pending: 0 },
  questions: { open: 0, deferred: 0 },
  net_worth: { net_worth: { THB: -250.5 } },
});

const TRANSACTIONS_LINES = [
  JSON.stringify({ ...CHARGE, source_file_id: "sf:1" }),
  JSON.stringify({ type: "summary", total: 1, returned: 1, has_more: false, limit: 500 }),
].join("\n");

interface Fake {
  runner: OpenLedgerRunner;
  argvs: string[][];
}

/** Answers each read with fabricated stdout, and keeps the argv it was asked for. */
function fakeRunner(accountLines: string[], transactions = TRANSACTIONS_LINES): Fake {
  const stdout: Record<string, string> = {
    status: STATUS_LINE,
    transactions,
    accounts: [...accountLines, summaryLine(accountLines.length)].join("\n"),
  };
  const argvs: string[][] = [];
  const runner: OpenLedgerRunner = {
    run: (argv) => {
      argvs.push(argv);
      const value = { argv, exitCode: 0, stdout: stdout[argv[0] ?? ""] ?? "", stderr: "" };
      return Promise.resolve({ ok: true, value });
    },
  };
  return { runner, argvs };
}

const FIVE_TYPES = [
  // A bank that paid out reads negative; a card that was charged reads positive.
  accountLine("thb:asset:bank:kbank", "asset", -1000),
  accountLine("thb:liability:card:ktc", "liability", 250.5),
  accountLine("thb:income:salary", "income", 45000),
  accountLine("thb:expense:food", "expense", 12.5),
  accountLine("thb:equity:openingbalance", "equity", 5000),
];

test("reads a signed balance for every account type, in minor units", () => {
  const balances = readBalances(listing(...FIVE_TYPES));
  assert.ok(balances.ok);
  assert.deepEqual(balances.value.balancesMinor, {
    "thb:asset:bank:kbank": -100000,
    "thb:liability:card:ktc": 25050,
    "thb:income:salary": 4500000,
    "thb:expense:food": 1250,
    "thb:equity:openingbalance": 500000,
  });
});

test("keeps an account that has no transactions, at zero", () => {
  const balances = readBalances(listing(accountLine("thb:expense:uncategorized", "expense", 0)));
  assert.ok(balances.ok);
  assert.deepEqual(balances.value.balancesMinor, { "thb:expense:uncategorized": 0 });
});

test("reads the terminator as a summary, never as an account", () => {
  const balances = readBalances(listing(...FIVE_TYPES));
  assert.ok(balances.ok);
  assert.equal(Object.keys(balances.value.balancesMinor).length, 5);
  assert.equal(balances.value.balancesMinor.summary, undefined);
  assert.ok(!Object.keys(balances.value.balancesMinor).some((id) => id.includes("summary")));
});

test("compares exactly where a float would not", () => {
  const drifted = 0.1 + 0.2;
  // The two values a float comparison gets wrong: 12.50 prints as 12.5, and
  // 0.1 + 0.2 prints as 0.30000000000000004.
  assert.notEqual(drifted, 0.3);
  const balances = readBalances(
    listing(
      accountLine("thb:expense:food", "expense", 12.5),
      accountLine("thb:expense:fee", "expense", drifted),
    ),
  );
  assert.ok(balances.ok);
  assert.equal(balances.value.balancesMinor["thb:expense:food"], 1250);
  assert.equal(balances.value.balancesMinor["thb:expense:food"], minorUnits(12.5));
  assert.equal(balances.value.balancesMinor["thb:expense:fee"], 30);
  assert.equal(balances.value.balancesMinor["thb:expense:fee"], minorUnits(0.3));
});

test("fails the probe on an account row whose shape changed", () => {
  const records = [
    JSON.parse(accountLine("thb:asset:bank:kbank", "asset", -1000)) as Record<string, unknown>,
    { id: "thb:asset:bank:scb", type: "asset", balance: "-2000" },
    JSON.parse(summaryLine(2)) as Record<string, unknown>,
  ];
  const balances = readBalances(records);
  assert.ok(!balances.ok);
  assert.equal(balances.error, "oled accounts list wrote 2 accounts but 1 were readable");
});

test("fails the probe when the listing has no terminator", () => {
  const balances = readBalances([
    JSON.parse(accountLine("thb:asset:bank:kbank", "asset", -1000)) as Record<string, unknown>,
  ]);
  assert.ok(!balances.ok);
  assert.equal(balances.error, "oled accounts list printed no summary row");
});

test("carries the balances into the probe without disturbing the rest of it", async () => {
  const { runner } = fakeRunner(FIVE_TYPES);
  const probe = await probeLedger(runner);
  assert.ok(probe.ok);
  assert.deepEqual(probe.value, {
    filesIngested: 1,
    filesPending: 0,
    postedRows: 1,
    uncategorizedRows: 0,
    questionsOpen: 0,
    questionsDeferred: 0,
    netWorth: -250.5,
    truncated: null,
    money: {
      charges: { count: 1, total: 250.5 },
      refunds: { count: 0, total: 0 },
      payments: { count: 0, total: 0 },
    },
    postings: [{ date: "2026-05-01", debit: "thb:expense:food", credit: "thb:liability:card:ktc", amountMinor: 25050 }],
    balancesMinor: {
      "thb:asset:bank:kbank": -100000,
      "thb:liability:card:ktc": 25050,
      "thb:income:salary": 4500000,
      "thb:expense:food": 1250,
      "thb:equity:openingbalance": 500000,
    },
    // accountLine defaults credits to nothing, so gross is the balance's magnitude here.
    grossMinor: {
      "thb:asset:bank:kbank": 100000,
      "thb:liability:card:ktc": 25050,
      "thb:income:salary": 4500000,
      "thb:expense:food": 1250,
      "thb:equity:openingbalance": 500000,
    },
  });
});

/** The date rides on the listing the rows already come from, so scoring one costs no extra call. */
test("every live row reaches the probe with its accounts, a voided one left out", async () => {
  const listed = [
    JSON.stringify(row("thb:expense:food", "thb:liability:card:ktc", 250.5, "2026-05-02")),
    JSON.stringify({
      ...row("thb:expense:food", "thb:liability:card:ktc", 99, "2026-05-03"),
      void_of: "tx:1",
    }),
    JSON.stringify({ type: "summary", total: 2, returned: 2, has_more: false, limit: 500 }),
  ].join("\n");
  const { runner } = fakeRunner(FIVE_TYPES, listed);
  const probe = await probeLedger(runner);
  assert.ok(probe.ok);
  assert.deepEqual(probe.value.postings, [{ date: "2026-05-02", debit: "thb:expense:food", credit: "thb:liability:card:ktc", amountMinor: 25050 }]);
});

test("asks every read for unredacted output", async () => {
  const { runner, argvs } = fakeRunner(FIVE_TYPES);
  await probeLedger(runner);
  assert.deepEqual(
    argvs.map((argv) => argv[0]),
    ["status", "transactions", "accounts"],
  );
  for (const argv of argvs) assert.ok(argv.includes("--no-redact"), argv.join(" "));
});

/**
 * The reading the whole adjustments check rests on. `accounts adjust` sets a
 * balance by posting the difference through equity, and adjusting a whole chart
 * into place moves equal amounts each way, so the account nets to zero while
 * money plainly went through it. A net balance cannot answer a gross question.
 */
test("tells an untouched account from one whose debits and credits cancelled out", () => {
  const balances = readBalances(
    listing(
      accountLine("thb:equity:adjustments", "equity", 0, { debits: 107570.25, credits: 107570.25 }),
      accountLine("thb:equity:opening", "equity", 0),
    ),
  );
  assert.ok(balances.ok);
  assert.equal(balances.value.balancesMinor["thb:equity:adjustments"], 0);
  assert.equal(balances.value.balancesMinor["thb:equity:opening"], 0);
  // Same balance, and only the gross figure separates them.
  assert.equal(balances.value.grossMinor["thb:equity:adjustments"], 21514050);
  assert.equal(balances.value.grossMinor["thb:equity:opening"], 0);
});
