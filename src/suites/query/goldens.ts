import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapValues } from "es-toolkit";
import * as z from "zod";
import {
  ACCOUNT_TYPES,
  currencyOf,
  isDebitNormal,
  typeOf,
  type AccountType,
} from "../../core/accounts.js";
import { majorUnits, minorUnits } from "../../core/money.js";
import { tryExecute, type Result } from "../../core/result.js";
import type { EvalCase } from "../types.js";
import { readRows, type SeedRow } from "./rows.js";

/**
 * Goldens are declared in the fixture and re-derived from the seed rows here.
 * A question whose two answers disagree fails the load, so no run is ever
 * scored against a number nobody can reproduce.
 */

const CURRENCY = z.string().regex(/^[A-Z]{3}$/, "a currency is a 3-letter uppercase code");
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD");
const TOLERANCE = z.number().positive().optional();

/** Every declared field must hold. `currency` is the row's ledger: oled refuses
 *  any row whose two sides sit in different ones, so either side names it. */
const FILTER = z.object({
  debit: z.array(z.string().min(1)).min(1).optional(),
  credit: z.array(z.string().min(1)).min(1).optional(),
  debitType: z.enum(ACCOUNT_TYPES).optional(),
  currency: CURRENCY.optional(),
  merchant: z.string().min(1).optional(),
  /** Inclusive. */
  from: ISO_DATE.optional(),
  /** Inclusive. */
  to: ISO_DATE.optional(),
  /** Strictly greater, in major units. */
  amountOver: z.number().nonnegative().optional(),
});

const DERIVATION = z.discriminatedUnion("op", [
  z.object({ op: z.literal("count"), where: FILTER }),
  z.object({ op: z.literal("sum"), where: FILTER }),
  z.object({ op: z.literal("balance"), account: z.string().min(1) }),
  z.object({ op: z.literal("net_worth"), currency: CURRENCY }),
  z.object({ op: z.literal("top_merchant"), where: FILTER }),
  z.object({ op: z.literal("delta"), of: FILTER, minus: FILTER }),
  z.object({ op: z.literal("per_currency_sum"), where: FILTER }),
]);

const GOLDEN = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count"), value: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("money"), value: z.number(), unit: CURRENCY, tolerance: TOLERANCE }),
  z.object({ kind: z.literal("number"), value: z.number(), tolerance: TOLERANCE }),
  z.object({ kind: z.literal("string"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("per_currency"),
    perCurrency: z
      .record(CURRENCY, z.number())
      .refine((totals) => Object.keys(totals).length > 0, "name at least one currency"),
    tolerance: TOLERANCE,
  }),
]);

const QUESTION = z.object({
  id: z.string().min(1),
  /** Verbatim what the model is asked; nothing is appended at run time. */
  prompt: z.string().min(1),
  golden: GOLDEN,
  derivation: DERIVATION,
  extraSeed: z.literal("paging").optional(),
});

const QUESTIONS = z.object({ note: z.string().min(1), cases: z.array(QUESTION).min(1) });

type RowFilter = z.infer<typeof FILTER>;
export type Derivation = z.infer<typeof DERIVATION>;
export type Golden = z.infer<typeof GOLDEN>;

export interface QueryCase extends EvalCase {
  prompt: string;
  golden: Golden;
  derivation: Derivation;
  extraSeed?: "paging";
  /** Resolved at load time so `prepare` reads no fixture from inside a sandbox. */
  rows: SeedRow[];
}

export type Derived =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "perCurrency"; value: Record<string, number> };

function matches(row: SeedRow, filter: RowFilter): boolean {
  if (filter.debit && !filter.debit.includes(row.debit_account)) return false;
  if (filter.credit && !filter.credit.includes(row.credit_account)) return false;
  if (filter.debitType && typeOf(row.debit_account) !== filter.debitType) return false;
  if (filter.currency && currencyOf(row.debit_account) !== filter.currency) return false;
  if (filter.merchant && row.merchant?.canonical_name !== filter.merchant) return false;
  if (filter.from && row.date < filter.from) return false;
  if (filter.to && row.date > filter.to) return false;
  if (filter.amountOver !== undefined && minorUnits(row.amount) <= minorUnits(filter.amountOver)) {
    return false;
  }
  return true;
}

function select(rows: SeedRow[], filter: RowFilter): SeedRow[] {
  return rows.filter((row) => matches(row, filter));
}

function sumMinor(rows: SeedRow[]): number {
  return rows.reduce((total, row) => total + minorUnits(row.amount), 0);
}

function balanceMinor(rows: SeedRow[], account: string, type: AccountType): number {
  const debits = sumMinor(rows.filter((row) => row.debit_account === account));
  const credits = sumMinor(rows.filter((row) => row.credit_account === account));
  return isDebitNormal(type) ? debits - credits : credits - debits;
}

function accountsOf(rows: SeedRow[]): string[] {
  return [...new Set(rows.flatMap((row) => [row.debit_account, row.credit_account]))];
}

function number(value: number): Result<Derived> {
  return { ok: true, value: { kind: "number", value } };
}

function deriveBalance(rows: SeedRow[], account: string): Result<Derived> {
  const type = typeOf(account);
  if (!type) return { ok: false, error: `${account} names no account type` };
  return number(majorUnits(balanceMinor(rows, account, type)));
}

function deriveNetWorth(rows: SeedRow[], currency: string): Result<Derived> {
  const scoped = accountsOf(rows).filter((id) => currencyOf(id) === currency);
  if (scoped.length === 0) return { ok: false, error: `no row touches the ${currency} ledger` };

  const held = (type: AccountType): number =>
    scoped
      .filter((id) => typeOf(id) === type)
      .reduce((total, id) => total + balanceMinor(rows, id, type), 0);
  return number(majorUnits(held("asset") - held("liability")));
}

function deriveTopMerchant(rows: SeedRow[], filter: RowFilter): Result<Derived> {
  const totals = new Map<string, number>();
  for (const row of select(rows, filter)) {
    const name = row.merchant?.canonical_name;
    if (!name) continue;
    totals.set(name, (totals.get(name) ?? 0) + minorUnits(row.amount));
  }

  const ranked = [...totals.entries()].sort(([, a], [, b]) => b - a);
  const top = ranked[0];
  if (!top) return { ok: false, error: "no matching row names a merchant" };

  const runnerUp = ranked[1];
  if (runnerUp && runnerUp[1] === top[1]) {
    return { ok: false, error: `${top[0]} and ${runnerUp[0]} tie at ${majorUnits(top[1])}` };
  }
  return { ok: true, value: { kind: "string", value: top[0] } };
}

function derivePerCurrencySum(rows: SeedRow[], filter: RowFilter): Result<Derived> {
  const totals: Record<string, number> = {};
  for (const row of select(rows, filter)) {
    const currency = currencyOf(row.debit_account);
    totals[currency] = (totals[currency] ?? 0) + minorUnits(row.amount);
  }
  if (Object.keys(totals).length === 0) return { ok: false, error: "no row matches" };
  return { ok: true, value: { kind: "perCurrency", value: mapValues(totals, majorUnits) } };
}

/** One entry per op: a new op fails to compile until it can be derived. */
const OPS: {
  [K in Derivation["op"]]: (
    rows: SeedRow[],
    derivation: Extract<Derivation, { op: K }>,
  ) => Result<Derived>;
} = {
  count: (rows, { where }) => number(select(rows, where).length),
  sum: (rows, { where }) => number(majorUnits(sumMinor(select(rows, where)))),
  balance: (rows, { account }) => deriveBalance(rows, account),
  net_worth: (rows, { currency }) => deriveNetWorth(rows, currency),
  top_merchant: (rows, { where }) => deriveTopMerchant(rows, where),
  delta: (rows, { of, minus }) =>
    number(majorUnits(sumMinor(select(rows, of)) - sumMinor(select(rows, minus)))),
  per_currency_sum: (rows, { where }) => derivePerCurrencySum(rows, where),
};

export function derive(rows: SeedRow[], derivation: Derivation): Result<Derived> {
  const op = OPS[derivation.op] as (rows: SeedRow[], d: Derivation) => Result<Derived>;
  return op(rows, derivation);
}

function money(amount: number): string {
  return amount.toFixed(2);
}

function currencyList(totals: Record<string, number>): string {
  return Object.entries(totals)
    .map(([currency, amount]) => `${currency} ${money(amount)}`)
    .join(", ");
}

/** Shared with the scorecard, so a report and a load failure name a golden the same way. */
export function describeGolden(golden: Golden): string {
  if (golden.kind === "count") return String(golden.value);
  if (golden.kind === "string") return JSON.stringify(golden.value);
  if (golden.kind === "per_currency") return currencyList(golden.perCurrency);
  if (golden.kind === "money") return `${money(golden.value)} ${golden.unit}`;
  return money(golden.value);
}

function describeDerived(derived: Derived): string {
  if (derived.kind === "string") return JSON.stringify(derived.value);
  if (derived.kind === "perCurrency") return currencyList(derived.value);
  return money(derived.value);
}

function sameMoney(a: number, b: number): boolean {
  return minorUnits(a) === minorUnits(b);
}

function perCurrencyDisagreement(
  want: Record<string, number>,
  got: Record<string, number>,
): boolean {
  const currencies = new Set([...Object.keys(want), ...Object.keys(got)]);
  return [...currencies].some((currency) => {
    const wanted = want[currency];
    const gotten = got[currency];
    return wanted === undefined || gotten === undefined || !sameMoney(wanted, gotten);
  });
}

/** null when the two agree exactly; the fixture is not held to a tolerance. */
function disagreement(golden: Golden, derived: Derived): string | null {
  const mismatch = `golden says ${describeGolden(golden)}, the rows say ${describeDerived(derived)}`;
  if (golden.kind === "string") {
    return derived.kind === "string" && derived.value === golden.value ? null : mismatch;
  }
  if (golden.kind === "per_currency") {
    if (derived.kind !== "perCurrency") return mismatch;
    return perCurrencyDisagreement(golden.perCurrency, derived.value) ? mismatch : null;
  }
  if (derived.kind !== "number") return mismatch;
  return sameMoney(golden.value, derived.value) ? null : mismatch;
}

/** Every case is replayed against the rows its own sandbox would hold. */
export function selfCheck(kase: QueryCase): string | null {
  const derived = derive(kase.rows, kase.derivation);
  if (!derived.ok) return `${kase.id}: the derivation failed: ${derived.error}`;

  const disagreed = disagreement(kase.golden, derived.value);
  return disagreed === null ? null : `${kase.id}: ${disagreed}`;
}

function readQuestions(path: string): Result<z.infer<typeof QUESTIONS>> {
  const json = tryExecute(() => JSON.parse(readFileSync(path, "utf8")) as unknown);
  if (!json.ok) return { ok: false, error: `cannot read ${path}: ${json.error}` };

  const parsed = QUESTIONS.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };
  return { ok: true, value: parsed.data };
}

/**
 * The sentence a question must carry to say, in the model's own terms, which
 * fields of `submit_answer` its answer belongs in.
 *
 * It lives here rather than only in the fixture so a question and the check that
 * grades it cannot drift apart: `expectationGap` refuses to load a case whose
 * prompt does not carry the sentence its golden kind calls for, which is the
 * same posture the derived goldens take. q09 was scored wrong for exactly this —
 * it asked for a merchant and the model wrote a sentence, because the only
 * instruction it had about `answer` said "a one-line summary".
 *
 * `per_currency` is deliberately null. Naming its shape would answer the
 * question: the one case with that golden asks whether a single total is even
 * meaningful across currencies, so telling the model to split by currency hands
 * it the very judgement under test. Its prompt states the choice instead.
 */
export const ANSWER_EXPECTATION: Record<Golden["kind"], string | null> = {
  count: "Answer with the whole number in `value`.",
  money: "Answer with the amount in `value` and its currency code in `unit`.",
  number: "Answer with the number in `value`.",
  string: "Put the name by itself in `answer`, with no sentence around it.",
  per_currency: null,
};

/** Why this question does not say what shape its answer takes, or null when it does. */
export function expectationGap(kase: { id: string; prompt: string; golden: Golden }): string | null {
  const wanted = ANSWER_EXPECTATION[kase.golden.kind];
  if (wanted === null || kase.prompt.includes(wanted)) return null;
  return `${kase.id} (${kase.golden.kind}) must end with ${JSON.stringify(wanted)}`;
}

export function loadQueryCases(fixturesDir: string): Result<QueryCase[]> {
  const dir = join(fixturesDir, "query");
  const questions = readQuestions(join(dir, "questions.json"));
  if (!questions.ok) return questions;

  const seed = readRows(join(dir, "seed.ndjson"));
  if (!seed.ok) return seed;

  const paging = readRows(join(dir, "paging-rows.ndjson"));
  if (!paging.ok) return paging;

  const cases: QueryCase[] = questions.value.cases.map((question) => ({
    ...question,
    rows: question.extraSeed ? [...seed.value, ...paging.value] : seed.value,
  }));

  // Before the goldens are checked, because this one costs no derivation: a
  // question that does not say where its answer goes scores the model's reading
  // of the tool description rather than its work on the ledger.
  const unstated = cases.map(expectationGap).filter((line) => line !== null);
  if (unstated.length > 0) {
    return { ok: false, error: `a query question does not state what its answer must look like: ${unstated.join("; ")}` };
  }

  const disagreements = cases.map(selfCheck).filter((line) => line !== null);
  if (disagreements.length > 0) {
    return { ok: false, error: `the query goldens disagree with the rows: ${disagreements.join("; ")}` };
  }
  return { ok: true, value: cases };
}
