import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";
import {
  ACCOUNT_ID_PATTERN,
  adjustmentsAccount,
  currencyOf,
  isDebitNormal,
  netWorthMinor,
  typeOf,
  uncategorizedAccount,
  type AccountType,
} from "../../core/accounts.js";
import { minorUnits } from "../../core/money.js";
import { tryExecute, type Result } from "../../core/result.js";
import type { LedgerPosting } from "../../oled/ledger.js";
import type { EvalCase } from "../types.js";

/**
 * One file per case: the transaction text a model is handed, and the rows it
 * must leave behind. The rows are the only truth written down — row count,
 * per-account balance and net worth are derived from them — and a case that
 * disagrees with itself or with its own input text fails the load, before a
 * single token is spent.
 */

const CASE_SUFFIX = ".json";

/** The one ledger `oled config --init` opens; any other has to be created by the model. */
const SEEDED_LEDGER = "thb";

/**
 * The resolve phase's cap. It is the same ask for every case, so a fixture states
 * only its own recording budget and this is the rest of the turn budget a run gets.
 */
export const RESOLVE_MAX_CALLS = 8;

const ACCOUNT_ID = z
  .string()
  .regex(ACCOUNT_ID_PATTERN, "an account id is <ccy>:<type>[:<segment>...], all lowercase");

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD");

/** Direction is carried by debit and credit, so an amount is never signed. */
const AMOUNT = z
  .number()
  .positive()
  .refine((amount) => Math.abs(amount * 100 - minorUnits(amount)) < 1e-6, "at most two decimals");

const ROW = z.object({
  date: ISO_DATE,
  description: z.string().min(1),
  debit: ACCOUNT_ID,
  credit: ACCOUNT_ID,
  amount: AMOUNT,
});

const CHART_ACCOUNT = z.object({ id: ACCOUNT_ID, name: z.string().min(1) });

const CASE = z.object({
  id: z.string().min(1),
  /** The input file beside this one, whose text is all the model is shown. */
  input: z.string().min(1),
  /** The recording phase's cap; every case then gets `RESOLVE_MAX_CALLS` more. */
  maxCalls: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/, "a currency is a 3-letter uppercase code"),
  /** The ledger the sandbox has not opened, so the first commit is refused; null when it has. */
  needsLedger: z.string().regex(/^[a-z]{3}$/, "a ledger prefix is 3 lowercase letters").nullable(),
  accounts: z.array(CHART_ACCOUNT).min(1),
  rows: z.array(ROW).min(1),
});

type RecordFixture = z.infer<typeof CASE>;

export type RecordRow = z.infer<typeof ROW>;

export type ChartAccount = z.infer<typeof CHART_ACCOUNT>;

/** Derived from the rows, in minor units: what the ledger has to hold when the run ends. */
export interface ExpectedLedger {
  /** One posted transaction per row, so a re-committed batch shows up as a higher count. */
  rowCount: number;
  /**
   * One (date, amount) pair per row. Balances and the row count both survive a
   * row posted on the wrong day, two rows merged into their sum, or one row split
   * in two; this is what does not.
   */
  postings: LedgerPosting[];
  /** One entry per chart account, zero balances included, signed by the account's normal side. */
  balancesMinor: Record<string, number>;
  /** Assets less liabilities, the way oled reports net worth. */
  netWorthMinor: number;
}

/**
 * The canonical rows are consumed at load time and deliberately not carried:
 * what a run is scored against is `expected`, so no code path downstream can
 * hand a model the answers it is being asked to derive.
 */
export interface RecordCase extends EvalCase {
  /** Verbatim, as the model is shown it. */
  inputText: string;
  /** The recording phase's cap; the resolve phase adds `RESOLVE_MAX_CALLS` to it. */
  maxCalls: number;
  currency: string;
  accounts: ChartAccount[];
  expected: ExpectedLedger;
}

interface LoadedFixture {
  fixture: RecordFixture;
  inputText: string;
}

const SIDES = ["debit", "credit"] as const;

function money(amount: number): string {
  return amount.toFixed(2);
}

/** The grammar already proved the second segment is a type, so a null here is a broken invariant. */
function accountType(accountId: string): AccountType {
  const type = typeOf(accountId);
  if (!type) throw new Error(`${accountId} passed the id grammar but names no account type`);
  return type;
}

function sumMinor(rows: RecordRow[]): number {
  return rows.reduce((total, row) => total + minorUnits(row.amount), 0);
}

function balanceMinor(rows: RecordRow[], accountId: string): number {
  const debits = sumMinor(rows.filter((row) => row.debit === accountId));
  const credits = sumMinor(rows.filter((row) => row.credit === accountId));
  return isDebitNormal(accountType(accountId)) ? debits - credits : credits - debits;
}

function expectedLedger(fixture: RecordFixture): ExpectedLedger {
  const balancesMinor = Object.fromEntries(
    fixture.accounts.map((account) => [account.id, balanceMinor(fixture.rows, account.id)]),
  );
  return {
    rowCount: fixture.rows.length,
    postings: fixture.rows.map((row) => ({
      date: row.date,
      debit: row.debit,
      credit: row.credit,
      amountMinor: minorUnits(row.amount),
    })),
    balancesMinor,
    netWorthMinor: netWorthMinor(balancesMinor),
  };
}

/**
 * How many times the text states one amount. The lookarounds are the whole point:
 * a plain substring finds 45.00 inside 145.00 and calls a missing amount stated.
 * A leading comma or space is a real boundary, a leading digit or decimal point is
 * not; only a trailing digit disqualifies, so a CSV's "45.00," still counts.
 *
 * Only the two-decimal spelling counts. A bare "45" would let a day of the month
 * or a seat count stand in for a row's amount, which is exactly the substitution
 * the occurrence count exists to catch.
 */
function statedTimes(inputText: string, amount: number): number {
  const literal = money(amount).replace(".", "\\.");
  return inputText.match(new RegExp(`(?<![\\d.])${literal}(?!\\d)`, "g"))?.length ?? 0;
}

/** Which rows use each amount, by row number, so a complaint can name them. */
function rowsPerAmount(rows: RecordRow[]): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  rows.forEach((row, index) => {
    grouped.set(row.amount, [...(grouped.get(row.amount) ?? []), index + 1]);
  });
  return grouped;
}

/**
 * Amounts against the text as a multiset. A text stating one 480.00 while two rows
 * use it is a row written down twice, and the count is the only place that shows.
 */
function amountComplaints(fixture: RecordFixture, inputText: string): string[] {
  return [...rowsPerAmount(fixture.rows)].flatMap(([amount, at]) => {
    const stated = statedTimes(inputText, amount);
    if (stated >= at.length) return [];
    const where = at.length === 1 ? `row ${at[0]}` : `rows ${at.join(", ")}`;
    if (stated === 0) {
      return [`${where}: ${money(amount)} never appears in ${fixture.input}`];
    }
    return [
      `${where}: ${money(amount)} appears ${stated}× in ${fixture.input} ` +
        `but ${at.length} rows use it`,
    ];
  });
}

/** THB is the only ledger a fresh sandbox opens, so every other currency owes a declaration. */
function ledgerComplaint(fixture: RecordFixture): string | null {
  const ledger = fixture.currency.toLowerCase();
  const declared = fixture.needsLedger;
  if (ledger === SEEDED_LEDGER) {
    return declared === null
      ? null
      : `needsLedger says ${declared}, but the ${SEEDED_LEDGER} ledger is open from the start`;
  }
  if (declared === ledger) return null;
  return `a ${fixture.currency} case must declare needsLedger ${ledger}, not ${JSON.stringify(declared)}`;
}

/** The accounts the scorecard reads as a failure, so a fixture aiming at one would make that check unfalsifiable. */
function signalAccounts(currency: string): string[] {
  return [uncategorizedAccount(currency), adjustmentsAccount(currency)];
}

function accountComplaints(fixture: RecordFixture): string[] {
  const signals = signalAccounts(fixture.currency);
  return fixture.accounts.flatMap((account) => {
    if (signals.includes(account.id)) {
      return [`the chart carries ${account.id}, which the harness reads as a failure`];
    }
    if (currencyOf(account.id) !== fixture.currency) {
      return [`the chart carries ${account.id}, which is not in the ${fixture.currency} ledger`];
    }
    return [];
  });
}

function rowComplaints(fixture: RecordFixture, chart: Set<string>): string[] {
  const signals = signalAccounts(fixture.currency);
  return fixture.rows.flatMap((row, index) => {
    const at = `row ${index + 1} (${row.date} ${row.description})`;
    const complaints = SIDES.flatMap((side) => {
      const id = row[side];
      if (signals.includes(id)) {
        return [`${at} ${side}s ${id}, which the harness reads as a failure`];
      }
      if (!chart.has(id)) return [`${at} ${side}s ${id}, which the chart does not carry`];
      if (currencyOf(id) !== fixture.currency) {
        return [`${at} ${side}s ${id}, which is not in the ${fixture.currency} ledger`];
      }
      return [];
    });
    if (row.debit === row.credit) {
      complaints.push(`${at} debits and credits ${row.debit}, so it moves nothing`);
    }
    return complaints;
  });
}

/** Every way one case can disagree with itself, named so a wrong fixture is fixable from the message alone. */
function selfCheck({ fixture, inputText }: LoadedFixture): string[] {
  const chart = new Set(fixture.accounts.map((account) => account.id));
  return [
    ...accountComplaints(fixture),
    ...rowComplaints(fixture, chart),
    ...amountComplaints(fixture, inputText),
    ledgerComplaint(fixture),
  ]
    .filter((complaint): complaint is string => complaint !== null)
    .map((complaint) => `${fixture.id}: ${complaint}`);
}

function readFixture(dir: string, file: string): Result<LoadedFixture> {
  const path = join(dir, file);
  const json = tryExecute(() => JSON.parse(readFileSync(path, "utf8")) as unknown);
  if (!json.ok) return { ok: false, error: `cannot read ${path}: ${json.error}` };

  const parsed = CASE.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };

  const fixture = parsed.data;
  const named = basename(file, CASE_SUFFIX);
  if (fixture.id !== named) {
    return { ok: false, error: `${path} calls itself ${fixture.id}, so it is not one case per file` };
  }

  const inputPath = join(dir, fixture.input);
  const inputText = tryExecute(() => readFileSync(inputPath, "utf8"));
  if (!inputText.ok) return { ok: false, error: `cannot read ${inputPath}: ${inputText.error}` };
  return { ok: true, value: { fixture, inputText: inputText.value } };
}

function toCase({ fixture, inputText }: LoadedFixture): RecordCase {
  return {
    id: fixture.id,
    inputText,
    maxCalls: fixture.maxCalls,
    currency: fixture.currency,
    accounts: fixture.accounts,
    expected: expectedLedger(fixture),
  };
}

/** The whole directory, so a new case is a new file and no registry has to be edited. */
export function loadRecordCases(fixturesDir: string): Result<RecordCase[]> {
  const dir = join(fixturesDir, "record");
  const listed = tryExecute(() => readdirSync(dir));
  if (!listed.ok) return { ok: false, error: `cannot read ${dir}: ${listed.error}` };

  const files = listed.value.filter((name) => name.endsWith(CASE_SUFFIX)).toSorted();
  if (files.length === 0) return { ok: false, error: `${dir} holds no case files` };

  const loaded: LoadedFixture[] = [];
  for (const file of files) {
    const fixture = readFixture(dir, file);
    if (!fixture.ok) return fixture;
    loaded.push(fixture.value);
  }

  // Every case is reported at once: a fixture pass that fixes one file at a
  // time hides how much of the set is wrong.
  const complaints = loaded.flatMap(selfCheck);
  if (complaints.length > 0) {
    return { ok: false, error: `the record cases disagree with themselves: ${complaints.join("; ")}` };
  }
  return { ok: true, value: loaded.map(toCase) };
}
