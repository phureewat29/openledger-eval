import { groupBy, mapValues, sumBy, uniq, uniqBy } from "es-toolkit";
import * as z from "zod";
import { currencyOf, typeOf } from "../../core/accounts.js";
import { majorUnits, minorUnits, money } from "../../core/money.js";
import type { Result } from "../../core/result.js";
import { runNdjson, type OpenLedgerRunner } from "../../oled/command.js";
import {
  LIST_LIMIT,
  LIST_SUMMARY,
  readBalances,
  readStatus,
  TRANSACTION_ROW,
} from "../../oled/ledger.js";
import { createSandboxRunner, initConfig } from "../../sandbox/session.js";
import { createWorkspace, type WorkspaceGuard } from "../../sandbox/workspace.js";
import type {
  Derivation,
  Golden,
  GoldenShape,
  QueryCase,
  QueryQuestion,
  RowFilter,
} from "./goldens.js";
import { seedLedger } from "./seed.js";

/**
 * Every golden the query suite scores against, read out of a ledger seeded in a
 * throwaway sandbox and asked through the CLI the model itself uses. The
 * harness reproduces none of oled's semantics: where oled publishes the figure
 * a question asks for it is taken verbatim, and what remains here is arithmetic
 * over the rows oled printed.
 *
 * It runs once per invocation, before a token is spent, and refuses the
 * invocation rather than scoring a run against a number nobody can reproduce.
 */

/** The listing's row, plus the two fields a question filters on that the probe has no use for. */
const QUERY_ROW = TRANSACTION_ROW.extend({
  currency: z.string(),
  merchant_name: z.string().nullable(),
});

/** What `oled report` publishes for a window, as its own object. */
const REPORT = z.object({
  from: z.string(),
  to: z.string(),
  income: z.record(z.string(), z.number()),
  expenses: z.record(z.string(), z.number()),
  net: z.record(z.string(), z.number()),
});

type QueryRow = z.infer<typeof QUERY_ROW>;
type ReportTotals = z.infer<typeof REPORT>;

interface ReportWindow {
  from: string;
  to: string;
}

/** One seeded ledger as the CLI describes it: the only source a golden may have. */
export interface LedgerSnapshot {
  rows: QueryRow[];
  /** Signed minor units, exactly as oled prints them; no debit-normal rule is applied here. */
  balancesMinor: Record<string, number>;
  netWorthByCurrency: Record<string, number>;
  reportByWindow: Record<string, ReportTotals>;
}

/** One reading of the snapshot, before a shape claims it. `currency` is absent
 *  only where the reading names no ledger at all, as a count does. */
type Derived =
  | { kind: "number"; value: number; currency?: string }
  | { kind: "string"; value: string }
  | { kind: "perCurrency"; value: Record<string, number> };

function windowKey({ from, to }: ReportWindow): string {
  return `${from}..${to}`;
}

/** One `oled report` per window a question names, however many questions name it. */
function windowsOf(questions: QueryQuestion[]): ReportWindow[] {
  const windows = questions.flatMap((question) =>
    "from" in question.derivation
      ? [{ from: question.derivation.from, to: question.derivation.to }]
      : [],
  );
  return uniqBy(windows, windowKey);
}

/**
 * The listing, held to its own terminator: a line this reading cannot parse is
 * a row that would go missing from a count with nobody the wiser, and a capped
 * read is a ledger the goldens have only seen part of.
 */
function readListing(records: Record<string, unknown>[]): Result<QueryRow[]> {
  const summaries = records.flatMap((record) => {
    const parsed = LIST_SUMMARY.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
  const summary = summaries[0];
  if (!summary) return { ok: false, error: "oled transactions list printed no summary row" };
  if (summary.has_more) {
    return {
      ok: false,
      error: `oled transactions list returned ${summary.returned} of ${summary.total} rows, and a golden needs the whole ledger`,
    };
  }

  const listed = records.filter((record) => record.type !== "summary");
  if (listed.length !== summary.returned) {
    return {
      ok: false,
      error: `oled transactions list wrote ${summary.returned} rows but printed ${listed.length} readable lines`,
    };
  }

  const rows: QueryRow[] = [];
  for (const record of listed) {
    const parsed = QUERY_ROW.safeParse(record);
    if (!parsed.success) {
      return {
        ok: false,
        error: `oled transactions list printed a row this reading cannot use: ${z.prettifyError(parsed.error)}`,
      };
    }
    rows.push(parsed.data);
  }
  // Voided rows are hidden unless `--include-void` asks for them; dropped here
  // in case a later CLI stops hiding them, because a void is not money.
  return { ok: true, value: rows.filter((row) => !row.void_of) };
}

async function readReport(
  runner: OpenLedgerRunner,
  window: ReportWindow,
): Promise<Result<ReportTotals>> {
  // No --no-redact: `report` prints totals and no text a redactor could rewrite,
  // and the flag is a usage error on this command.
  const records = await runNdjson(runner, `oled report ${windowKey(window)}`, [
    "report",
    "--from",
    window.from,
    "--to",
    window.to,
    "--json",
  ]);
  if (!records.ok) return records;

  const parsed = REPORT.safeParse(records.value[0]);
  if (!parsed.success) {
    return {
      ok: false,
      error: `oled report ${windowKey(window)} was unreadable: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** Four reads of one seeded ledger: the rows, the chart, the status, and a report per window asked for. */
export async function readLedger(
  runner: OpenLedgerRunner,
  questions: QueryQuestion[],
): Promise<Result<LedgerSnapshot>> {
  const listed = await runNdjson(runner, "oled transactions list", [
    "transactions",
    "list",
    "--limit",
    String(LIST_LIMIT),
    "--no-redact",
    "--json",
  ]);
  if (!listed.ok) return listed;

  const rows = readListing(listed.value);
  if (!rows.ok) return rows;

  const accounts = await runNdjson(runner, "oled accounts list", [
    "accounts",
    "list",
    "--no-redact",
    "--json",
  ]);
  if (!accounts.ok) return accounts;

  const balances = readBalances(accounts.value);
  if (!balances.ok) return balances;

  const status = await runNdjson(runner, "oled status", ["status", "--no-redact", "--json"]);
  if (!status.ok) return status;

  const report = readStatus(status.value);
  if (!report.ok) return report;

  const reportByWindow: Record<string, ReportTotals> = {};
  for (const window of windowsOf(questions)) {
    const totals = await readReport(runner, window);
    if (!totals.ok) return totals;
    reportByWindow[windowKey(window)] = totals.value;
  }

  return {
    ok: true,
    value: {
      rows: rows.value,
      balancesMinor: balances.value.balancesMinor,
      netWorthByCurrency: report.value.net_worth?.net_worth ?? {},
      reportByWindow,
    },
  };
}

function matches(row: QueryRow, filter: RowFilter): boolean {
  if (filter.debit && !filter.debit.includes(row.debit_account_id)) return false;
  if (filter.credit && !filter.credit.includes(row.credit_account_id)) return false;
  if (filter.debitType && typeOf(row.debit_account_id) !== filter.debitType) return false;
  if (filter.currency && row.currency !== filter.currency) return false;
  if (filter.merchant && row.merchant_name !== filter.merchant) return false;
  if (filter.from && row.date < filter.from) return false;
  if (filter.to && row.date > filter.to) return false;
  if (filter.amountOver !== undefined && minorUnits(row.amount) <= minorUnits(filter.amountOver)) {
    return false;
  }
  return true;
}

function select(rows: QueryRow[], filter: RowFilter): QueryRow[] {
  return rows.filter((row) => matches(row, filter));
}

function totalMinor(rows: QueryRow[]): number {
  return sumBy(rows, (row) => minorUnits(row.amount));
}

/**
 * One ledger, or nothing to say. Adding baht to dollars is not a total and
 * ranking one against the other is not a ranking, so a filter that reaches two
 * currencies refuses rather than fusing them.
 */
function soleCurrency(rows: QueryRow[]): Result<string> {
  const currencies = uniq(rows.map((row) => row.currency));
  const [only, ...rest] = currencies;
  if (only === undefined) return { ok: false, error: "no row matches" };
  if (rest.length > 0) {
    return { ok: false, error: `the matching rows span ${currencies.join(" and ")}` };
  }
  return { ok: true, value: only };
}

function sumOf(rows: QueryRow[]): Result<Derived> {
  const currency = soleCurrency(rows);
  if (!currency.ok) return currency;
  return {
    ok: true,
    value: { kind: "number", value: majorUnits(totalMinor(rows)), currency: currency.value },
  };
}

function deltaOf(rows: QueryRow[], of: RowFilter, minus: RowFilter): Result<Derived> {
  const before = select(rows, minus);
  const after = select(rows, of);

  const currency = soleCurrency([...after, ...before]);
  if (!currency.ok) return currency;
  return {
    ok: true,
    value: {
      kind: "number",
      value: majorUnits(totalMinor(after) - totalMinor(before)),
      currency: currency.value,
    },
  };
}

function topMerchant(rows: QueryRow[]): Result<Derived> {
  const currency = soleCurrency(rows);
  if (!currency.ok) return currency;

  const named = rows.flatMap((row) =>
    row.merchant_name === null ? [] : [{ name: row.merchant_name, minor: minorUnits(row.amount) }],
  );
  const totals = mapValues(
    groupBy(named, (entry) => entry.name),
    (entries) => sumBy(entries, (entry) => entry.minor),
  );

  const ranked = Object.entries(totals).toSorted(([, a], [, b]) => b - a);
  const top = ranked[0];
  if (!top) return { ok: false, error: "no matching row names a merchant" };

  const runnerUp = ranked[1];
  if (runnerUp && runnerUp[1] === top[1]) {
    return { ok: false, error: `${top[0]} and ${runnerUp[0]} tie at ${money(majorUnits(top[1]))}` };
  }
  return { ok: true, value: { kind: "string", value: top[0] } };
}

/** Taken as oled printed it, already signed by the account's own normal side. */
function balanceOf(snapshot: LedgerSnapshot, account: string): Result<Derived> {
  const minor = snapshot.balancesMinor[account];
  if (minor === undefined) return { ok: false, error: `oled lists no account ${account}` };
  return {
    ok: true,
    value: { kind: "number", value: majorUnits(minor), currency: currencyOf(account) },
  };
}

function netWorthOf(snapshot: LedgerSnapshot, currency: string): Result<Derived> {
  const value = snapshot.netWorthByCurrency[currency];
  if (value === undefined) {
    return { ok: false, error: `oled status reports no net worth in ${currency}` };
  }
  return { ok: true, value: { kind: "number", value, currency } };
}

function reportFor(snapshot: LedgerSnapshot, window: ReportWindow): Result<ReportTotals> {
  const totals = snapshot.reportByWindow[windowKey(window)];
  if (!totals) return { ok: false, error: `no report was read for ${windowKey(window)}` };
  return { ok: true, value: totals };
}

/** One entry per op: a new op fails to compile until the ledger can answer it. */
const OPS: {
  [K in Derivation["op"]]: (
    snapshot: LedgerSnapshot,
    derivation: Extract<Derivation, { op: K }>,
  ) => Result<Derived>;
} = {
  count: (snapshot, { where }) => ({
    ok: true,
    value: { kind: "number", value: select(snapshot.rows, where).length },
  }),
  sum: (snapshot, { where }) => sumOf(select(snapshot.rows, where)),
  delta: (snapshot, { of, minus }) => deltaOf(snapshot.rows, of, minus),
  top_merchant: (snapshot, { where }) => topMerchant(select(snapshot.rows, where)),
  balance: (snapshot, { account }) => balanceOf(snapshot, account),
  net_worth: (snapshot, { currency }) => netWorthOf(snapshot, currency),
  expenses: (snapshot, { from, to, currency }) => {
    const totals = reportFor(snapshot, { from, to });
    if (!totals.ok) return totals;

    const value = totals.value.expenses[currency];
    if (value === undefined) {
      return { ok: false, error: `oled report ${from}..${to} holds no ${currency} expenses` };
    }
    return { ok: true, value: { kind: "number", value, currency } };
  },
  expenses_by_currency: (snapshot, { from, to }) => {
    const totals = reportFor(snapshot, { from, to });
    if (!totals.ok) return totals;

    const expenses = totals.value.expenses;
    if (Object.keys(expenses).length === 0) {
      return { ok: false, error: `oled report ${from}..${to} holds no expenses at all` };
    }
    return { ok: true, value: { kind: "perCurrency", value: expenses } };
  },
};

function wrongKind(kind: GoldenShape["kind"], derived: Derived): string {
  return `the ledger answered with a ${derived.kind}, which cannot fill a ${kind} golden`;
}

/** One entry per shape: a new kind fails to compile until a reading can fill it. */
const FILL: {
  [K in Golden["kind"]]: (
    shape: Extract<GoldenShape, { kind: K }>,
    derived: Derived,
  ) => Result<Golden>;
} = {
  count: (shape, derived) => {
    if (derived.kind !== "number") return { ok: false, error: wrongKind(shape.kind, derived) };
    if (!Number.isInteger(derived.value)) {
      return { ok: false, error: `a count needs a whole number, and the ledger answered ${derived.value}` };
    }
    return { ok: true, value: { kind: "count", value: derived.value } };
  },
  money: (shape, derived) => {
    if (derived.kind !== "number") return { ok: false, error: wrongKind(shape.kind, derived) };
    if (derived.currency !== shape.unit) {
      return {
        ok: false,
        error: `the question is asked in ${shape.unit} and the ledger answered in ${derived.currency ?? "no currency at all"}`,
      };
    }
    return {
      ok: true,
      value: { kind: "money", value: derived.value, unit: shape.unit, tolerance: shape.tolerance },
    };
  },
  number: (shape, derived) =>
    derived.kind === "number"
      ? { ok: true, value: { kind: "number", value: derived.value, tolerance: shape.tolerance } }
      : { ok: false, error: wrongKind(shape.kind, derived) },
  string: (shape, derived) =>
    derived.kind === "string"
      ? { ok: true, value: { kind: "string", value: derived.value } }
      : { ok: false, error: wrongKind(shape.kind, derived) },
  per_currency: (shape, derived) =>
    derived.kind === "perCurrency"
      ? {
          ok: true,
          value: { kind: "per_currency", perCurrency: derived.value, tolerance: shape.tolerance },
        }
      : { ok: false, error: wrongKind(shape.kind, derived) },
};

function answer(snapshot: LedgerSnapshot, question: QueryQuestion): Result<Golden> {
  const op = OPS[question.derivation.op] as (
    snapshot: LedgerSnapshot,
    derivation: Derivation,
  ) => Result<Derived>;
  const derived = op(snapshot, question.derivation);
  if (!derived.ok) return derived;

  const fill = FILL[question.shape.kind] as (
    shape: GoldenShape,
    derived: Derived,
  ) => Result<Golden>;
  return fill(question.shape, derived.value);
}

/** Every question the snapshot can answer, or every reason it cannot. */
export function resolveGoldens(
  snapshot: LedgerSnapshot,
  questions: QueryQuestion[],
): Result<QueryCase[]> {
  const cases: QueryCase[] = [];
  const refused: string[] = [];
  for (const question of questions) {
    const golden = answer(snapshot, question);
    if (!golden.ok) {
      refused.push(`${question.id}: ${golden.error}`);
      continue;
    }
    const { shape, ...rest } = question;
    cases.push({ ...rest, golden: golden.value });
  }

  if (refused.length === 0) return { ok: true, value: cases };
  return {
    ok: false,
    error: `the seeded ledger does not answer every question: ${refused.join("; ")}`,
  };
}

/** One sandbox, seeded by the same path a run seeds its own, and thrown away after. */
async function fromSeededLedger(
  questions: QueryQuestion[],
  rows: QueryQuestion["rows"],
  guard: WorkspaceGuard,
): Promise<Result<QueryCase[]>> {
  const created = createWorkspace();
  if (!created.ok) return created;

  const workspace = created.value;
  guard.register(workspace);
  try {
    const runner = createSandboxRunner(workspace);
    const configured = await initConfig(runner, workspace);
    if (!configured.ok) return configured;

    const seeded = await seedLedger(runner, rows);
    if (!seeded.ok) return seeded;

    const snapshot = await readLedger(runner, questions);
    if (!snapshot.ok) return snapshot;
    return resolveGoldens(snapshot.value, questions);
  } finally {
    guard.release(workspace);
  }
}

/**
 * Questions that seed the same ledger share one sandbox; questions that ask for
 * the paging rows get their own, because a count over the wrong ledger is a
 * wrong golden. Every group's rows are identical by construction — the loader
 * gives a question its rows from the same `extraSeed` this groups by.
 */
export async function deriveQueryGoldens(
  questions: QueryQuestion[],
  guard: WorkspaceGuard,
): Promise<Result<QueryCase[]>> {
  const answered = new Map<string, QueryCase>();
  for (const group of Object.values(groupBy(questions, (question) => question.extraSeed ?? "seed"))) {
    const rows = group[0]?.rows ?? [];
    const derived = await fromSeededLedger(group, rows, guard);
    if (!derived.ok) return derived;
    for (const kase of derived.value) answered.set(kase.id, kase);
  }

  // Back into the fixture's own order, so a plan reads the way the file does.
  const cases = questions.flatMap((question) => {
    const kase = answered.get(question.id);
    return kase ? [kase] : [];
  });
  if (cases.length === questions.length) return { ok: true, value: cases };
  return {
    ok: false,
    error: `${questions.length - cases.length} query questions were never put to a ledger`,
  };
}
