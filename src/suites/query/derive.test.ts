import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "../../core/result.js";
import type { OpenLedgerRunner } from "../../oled/command.js";
import { readLedger, resolveGoldens } from "./derive.js";
import {
  ANSWER_EXPECTATION,
  type Derivation,
  type Golden,
  type GoldenShape,
  type QueryCase,
  type QueryQuestion,
} from "./goldens.js";

/**
 * Every golden here is read out of canned CLI output, so a test proves where a
 * number came from rather than what it is. The figures oled publishes are
 * deliberately set to numbers the rows do not add up to: a golden that followed
 * the harness's own arithmetic instead of the CLI would fail these.
 */

interface ListedRow {
  date: string;
  debit: string;
  credit: string;
  amount: number;
  merchant?: string;
  currency?: string;
  voidOf?: string;
}

function listed(row: ListedRow): Record<string, unknown> {
  return {
    id: `tx:${row.date}:${row.debit}`,
    date: row.date,
    description: "a row",
    debit_account_id: row.debit,
    credit_account_id: row.credit,
    amount: row.amount,
    currency: row.currency ?? "THB",
    merchant_name: row.merchant ?? null,
    void_of: row.voidOf ?? null,
    source_file_id: null,
  };
}

function ndjson(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function listing(rows: Record<string, unknown>[], has_more = false): string {
  const returned = rows.length;
  return ndjson([...rows, { type: "summary", total: returned, returned, has_more, limit: 500 }]);
}

function account(id: string, type: string, balance: number): Record<string, unknown> {
  return {
    id,
    name: id,
    type,
    currency: id.slice(0, 3).toUpperCase(),
    balance,
    debits_posted: Math.abs(balance),
    credits_posted: 0,
  };
}

function chart(rows: Record<string, unknown>[]): string {
  return ndjson([...rows, { type: "summary", total: rows.length, returned: rows.length }]);
}

const ROWS = [
  listed({ date: "2026-04-25", debit: "thb:expense:food:coffee", credit: "thb:asset:bank:kbank", amount: 120, merchant: "Roots" }),
  listed({ date: "2026-05-02", debit: "thb:expense:food:coffee", credit: "thb:asset:bank:kbank", amount: 80.5, merchant: "Roots" }),
  listed({ date: "2026-05-09", debit: "thb:expense:food:restaurants", credit: "thb:liability:card:visa", amount: 300, merchant: "Grab" }),
  listed({ date: "2026-05-20", debit: "thb:asset:bank:kbank", credit: "thb:income:salary", amount: 1000 }),
  listed({ date: "2026-05-21", debit: "usd:expense:software", credit: "usd:asset:bank:wise", amount: 12, merchant: "GitHub", currency: "USD" }),
];

// 812.25 is no sum of the rows above; the rows would make this balance 799.50.
const CHART = chart([
  account("thb:asset:bank:kbank", "asset", 812.25),
  account("thb:liability:card:visa", "liability", 300),
  account("thb:income:salary", "income", 1000),
  account("thb:expense:food:coffee", "expense", 200.5),
  account("thb:expense:food:restaurants", "expense", 300),
  account("usd:asset:bank:wise", "asset", -12),
  account("usd:expense:software", "expense", 12),
]);

// Likewise: the rows put THB net worth at 499.50 and May THB expenses at 380.50.
const STATUS = JSON.stringify({
  db: { reachable: true, error: null },
  counts: { transactions: 5 },
  files: { ingested: 0, pending: 0 },
  questions: { open: 0, deferred: 0 },
  net_worth: { net_worth: { THB: 4321.5, USD: -12 } },
});

const REPORT = JSON.stringify({
  from: "2026-05-01",
  to: "2026-05-31",
  income: { THB: 1000 },
  expenses: { THB: 400, USD: 12 },
  net: { THB: 600, USD: -12 },
});

const STDOUT: Record<string, string> = {
  transactions: listing(ROWS),
  accounts: CHART,
  status: STATUS,
  report: REPORT,
};

interface Fake {
  runner: OpenLedgerRunner;
  argvs: string[][];
}

/** Answers each read with canned stdout, keeps the argv, and can fail one command. */
function fakeRunner(stdout: Record<string, string> = STDOUT, failing = ""): Fake {
  const argvs: string[][] = [];
  const runner: OpenLedgerRunner = {
    run: (argv) => {
      argvs.push(argv);
      const command = argv[0] ?? "";
      const broke = command === failing;
      return Promise.resolve({
        ok: true as const,
        value: {
          argv,
          exitCode: broke ? 1 : 0,
          stdout: broke ? "" : (stdout[command] ?? ""),
          stderr: broke ? "the ledger is not reachable" : "",
        },
      });
    },
  };
  return { runner, argvs };
}

const MAY = { from: "2026-05-01", to: "2026-05-31" };

function ask(id: string, shape: GoldenShape, derivation: Derivation): QueryQuestion {
  return {
    id,
    prompt: `${id}? ${ANSWER_EXPECTATION[shape.kind] ?? ""}`,
    shape,
    derivation,
    rows: [],
  };
}

const THB: GoldenShape = { kind: "money", unit: "THB" };
const COUNT: GoldenShape = { kind: "count" };

async function resolve(fake: Fake, questions: QueryQuestion[]): Promise<Result<QueryCase[]>> {
  const snapshot = await readLedger(fake.runner, questions);
  if (!snapshot.ok) return snapshot;
  return resolveGoldens(snapshot.value, questions);
}

async function goldenOf(question: QueryQuestion, fake = fakeRunner()): Promise<Golden> {
  const resolved = await resolve(fake, [question]);
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.error);

  const kase = resolved.value.find((candidate) => candidate.id === question.id);
  assert.ok(kase, `no case ${question.id}`);
  return kase.golden;
}

async function refusal(question: QueryQuestion, fake = fakeRunner()): Promise<string> {
  const resolved = await resolve(fake, [question]);
  assert.equal(resolved.ok, false, "expected a refusal");
  return resolved.ok ? "" : resolved.error;
}

test("a money golden is what oled report says, not what the rows add up to", async () => {
  const golden = await goldenOf(ask("q05", THB, { op: "expenses", ...MAY, currency: "THB" }));
  assert.deepEqual(golden, { kind: "money", value: 400, unit: "THB", tolerance: undefined });
});

test("a per-currency golden is the report's own split, ledger by ledger", async () => {
  const golden = await goldenOf(ask("q12", { kind: "per_currency" }, { op: "expenses_by_currency", ...MAY }));
  assert.deepEqual(golden, {
    kind: "per_currency",
    perCurrency: { THB: 400, USD: 12 },
    tolerance: undefined,
  });
});

test("net worth is what oled status reports for that ledger", async () => {
  const golden = await goldenOf(ask("q02", THB, { op: "net_worth", currency: "THB" }));
  assert.deepEqual(golden, { kind: "money", value: 4321.5, unit: "THB", tolerance: undefined });
});

test("net worth refuses a ledger status does not report", async () => {
  const refused = await refusal(ask("q02", { kind: "money", unit: "EUR" }, { op: "net_worth", currency: "EUR" }));
  assert.match(refused, /q02: oled status reports no net worth in EUR/);
});

test("a balance is the account's own signed balance from the chart", async () => {
  const golden = await goldenOf(ask("q06", THB, { op: "balance", account: "thb:asset:bank:kbank" }));
  assert.deepEqual(golden, { kind: "money", value: 812.25, unit: "THB", tolerance: undefined });
});

test("a balance refuses an account oled does not list", async () => {
  const refused = await refusal(ask("q06", THB, { op: "balance", account: "thb:asset:bank:scb" }));
  assert.match(refused, /q06: oled lists no account thb:asset:bank:scb/);
});

test("a count is taken over the rows the listing printed", async () => {
  assert.deepEqual(await goldenOf(ask("q01", COUNT, { op: "count", where: {} })), {
    kind: "count",
    value: 5,
  });
  assert.deepEqual(await goldenOf(ask("q03", COUNT, { op: "count", where: { debit: ["thb:expense:food:coffee"], ...MAY } })), {
    kind: "count",
    value: 1,
  });
  assert.deepEqual(await goldenOf(ask("q03", COUNT, { op: "count", where: { credit: ["thb:income:salary"] } })), {
    kind: "count",
    value: 1,
  });
  assert.deepEqual(await goldenOf(ask("q03", COUNT, { op: "count", where: { debitType: "expense", currency: "USD" } })), {
    kind: "count",
    value: 1,
  });
  assert.deepEqual(await goldenOf(ask("q03", COUNT, { op: "count", where: { merchant: "Roots" } })), {
    kind: "count",
    value: 2,
  });
});

test("amountOver is strict, so a row exactly on the threshold does not count", async () => {
  const coffee = { debit: ["thb:expense:food:coffee"] };
  assert.deepEqual(await goldenOf(ask("q11", COUNT, { op: "count", where: { ...coffee, amountOver: 80.5 } })), {
    kind: "count",
    value: 1,
  });
  assert.deepEqual(await goldenOf(ask("q11", COUNT, { op: "count", where: { ...coffee, amountOver: 80.49 } })), {
    kind: "count",
    value: 2,
  });
});

test("a sum adds the listed rows in minor units", async () => {
  const golden = await goldenOf(ask("q04", THB, { op: "sum", where: { debit: ["thb:expense:food:coffee"] } }));
  assert.deepEqual(golden, { kind: "money", value: 200.5, unit: "THB", tolerance: undefined });
});

test("a delta subtracts the second window from the first", async () => {
  const coffee = ["thb:expense:food:coffee"];
  const golden = await goldenOf(
    ask("q10", THB, {
      op: "delta",
      of: { debit: coffee, ...MAY },
      minus: { debit: coffee, from: "2026-04-01", to: "2026-04-30" },
    }),
  );
  assert.deepEqual(golden, { kind: "money", value: -39.5, unit: "THB", tolerance: undefined });
});

test("top merchant ranks by total, not by number of rows", async () => {
  const golden = await goldenOf(
    ask("q09", { kind: "string" }, { op: "top_merchant", where: { debitType: "expense", currency: "THB" } }),
  );
  // Roots has two rows to Grab's one, and Grab still wins on the money.
  assert.deepEqual(golden, { kind: "string", value: "Grab" });
});

test("top merchant refuses a tie rather than picking a side", async () => {
  const tied = fakeRunner({
    ...STDOUT,
    transactions: listing([
      listed({ date: "2026-05-02", debit: "thb:expense:food:coffee", credit: "thb:asset:bank:kbank", amount: 300, merchant: "Roots" }),
      listed({ date: "2026-05-09", debit: "thb:expense:food:restaurants", credit: "thb:asset:bank:kbank", amount: 300, merchant: "Grab" }),
    ]),
  });
  const refused = await refusal(ask("q09", { kind: "string" }, { op: "top_merchant", where: {} }), tied);
  assert.match(refused, /q09: /);
  assert.match(refused, /tie at 300\.00/);
});

test("top merchant refuses a window whose rows name no merchant", async () => {
  const refused = await refusal(
    ask("q09", { kind: "string" }, { op: "top_merchant", where: { credit: ["thb:income:salary"] } }),
  );
  assert.match(refused, /q09: no matching row names a merchant/);
});

test("a filter reaching two ledgers refuses instead of fusing them", async () => {
  const refused = await refusal(ask("q08", THB, { op: "sum", where: { debitType: "expense", ...MAY } }));
  assert.match(refused, /q08: the matching rows span THB and USD/);
});

test("a filter that matches nothing refuses, because no total names a currency", async () => {
  const refused = await refusal(ask("q08", THB, { op: "sum", where: { merchant: "Nobody" } }));
  assert.match(refused, /q08: no row matches/);
});

test("a golden must be in the currency its question asks for", async () => {
  const refused = await refusal(
    ask("q04", { kind: "money", unit: "THB" }, { op: "sum", where: { debit: ["usd:expense:software"] } }),
  );
  assert.match(refused, /q04: the question is asked in THB and the ledger answered in USD/);
});

test("a count golden refuses a reading that is not a whole number", async () => {
  const refused = await refusal(ask("q01", COUNT, { op: "sum", where: { debit: ["thb:expense:food:coffee"] } }));
  assert.match(refused, /q01: a count needs a whole number, and the ledger answered 200\.5/);
});

test("a string golden refuses a number, and a number golden refuses a name", async () => {
  const gaveNumber = await refusal(ask("q09", { kind: "string" }, { op: "count", where: {} }));
  assert.match(gaveNumber, /cannot fill a string golden/);

  const gaveName = await refusal(ask("q05", THB, { op: "top_merchant", where: { merchant: "Grab" } }));
  assert.match(gaveName, /cannot fill a money golden/);
});

test("every question that cannot be answered is named, not just the first", async () => {
  const refused = await refusal(ask("q02", THB, { op: "net_worth", currency: "EUR" }));
  assert.match(refused, /^the seeded ledger does not answer every question: q02: /);

  const both = await resolve(fakeRunner(), [
    ask("q02", THB, { op: "net_worth", currency: "EUR" }),
    ask("q06", THB, { op: "balance", account: "thb:asset:bank:scb" }),
  ]);
  assert.equal(both.ok, false);
  assert.match(both.ok ? "" : both.error, /q02: .*; q06: /);
});

test("a read that fails refuses loudly, naming the command that failed", async () => {
  const resolved = await resolve(fakeRunner(STDOUT, "report"), [
    ask("q05", THB, { op: "expenses", ...MAY, currency: "THB" }),
  ]);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /oled report 2026-05-01\.\.2026-05-31 exited 1/);
});

test("a listing that fails takes the whole derivation with it", async () => {
  const resolved = await resolve(fakeRunner(STDOUT, "transactions"), [
    ask("q01", COUNT, { op: "count", where: {} }),
  ]);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /oled transactions list exited 1/);
});

test("a capped listing refuses, because a golden needs the whole ledger", async () => {
  const capped = fakeRunner({ ...STDOUT, transactions: listing(ROWS, true) });
  const resolved = await resolve(capped, [ask("q01", COUNT, { op: "count", where: {} })]);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /returned 5 of 5 rows, and a golden needs the whole ledger/);
});

test("a row printed in a shape this reading cannot use refuses, rather than going missing", async () => {
  const { currency: _dropped, ...noCurrency } = listed({
    date: "2026-05-02",
    debit: "thb:expense:food:coffee",
    credit: "thb:asset:bank:kbank",
    amount: 80.5,
  });
  const changed = fakeRunner({ ...STDOUT, transactions: listing([noCurrency]) });
  const resolved = await resolve(changed, [ask("q01", COUNT, { op: "count", where: {} })]);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /printed a row this reading cannot use/);
});

test("a listing whose terminator does not match what it printed refuses", async () => {
  const short = ndjson([...ROWS, { type: "summary", total: 9, returned: 9, has_more: false, limit: 500 }]);
  const resolved = await resolve(fakeRunner({ ...STDOUT, transactions: short }), [
    ask("q01", COUNT, { op: "count", where: {} }),
  ]);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /wrote 9 rows but printed 5 readable lines/);
});

test("a voided row is not money, and never reaches a golden", async () => {
  const withVoid = fakeRunner({
    ...STDOUT,
    transactions: listing([
      ...ROWS,
      listed({ date: "2026-05-11", debit: "thb:expense:food:coffee", credit: "thb:asset:bank:kbank", amount: 999, voidOf: "tx:1" }),
    ]),
  });
  assert.deepEqual(await goldenOf(ask("q01", COUNT, { op: "count", where: {} }), withVoid), {
    kind: "count",
    value: 5,
  });
});

test("one oled report per window, however many questions name it", async () => {
  const fake = fakeRunner();
  const resolved = await resolve(fake, [
    ask("q05", THB, { op: "expenses", ...MAY, currency: "THB" }),
    ask("q12", { kind: "per_currency" }, { op: "expenses_by_currency", ...MAY }),
  ]);
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.error);
  assert.deepEqual(
    fake.argvs.map((argv) => argv[0]),
    ["transactions", "accounts", "status", "report"],
  );
});

test("no report is read at all when no question names a window", async () => {
  const fake = fakeRunner();
  await resolve(fake, [ask("q01", COUNT, { op: "count", where: {} })]);
  assert.ok(!fake.argvs.some((argv) => argv[0] === "report"));
});

/** Redaction rewrites innocuous text, and a rewritten merchant name is a wrong golden. */
test("every read that carries text asks for it unredacted", async () => {
  const fake = fakeRunner();
  await resolve(fake, [ask("q05", THB, { op: "expenses", ...MAY, currency: "THB" })]);
  for (const argv of fake.argvs) {
    // `report` prints totals only, and refuses the flag as a usage error.
    if (argv[0] === "report") continue;
    assert.ok(argv.includes("--no-redact"), argv.join(" "));
  }
});
