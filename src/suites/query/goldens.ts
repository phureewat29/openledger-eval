import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { ACCOUNT_TYPES } from "../../core/accounts.js";
import { money } from "../../core/money.js";
import { tryExecute, type Result } from "../../core/result.js";
import type { EvalCase } from "../types.js";
import { readRows, type SeedRow } from "./rows.js";

/**
 * A question states the shape its answer takes and how oled is asked for the
 * number. It states no number: the goldens are read out of a seeded ledger
 * through the CLI itself (`derive.ts`), once per invocation. Nothing here
 * reproduces oled's arithmetic, so no golden can disagree with the ledger a
 * model reads.
 */

const CURRENCY = z.string().regex(/^[A-Z]{3}$/, "a currency is a 3-letter uppercase code");
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD");
const TOLERANCE = z.number().positive().optional();

/** Every declared field must hold, and each is read off the row oled printed. */
const FILTER = z.object({
  debit: z.array(z.string().min(1)).min(1).optional(),
  credit: z.array(z.string().min(1)).min(1).optional(),
  debitType: z.enum(ACCOUNT_TYPES).optional(),
  /** The row's own ledger, as oled prints it; the two sides always share one. */
  currency: CURRENCY.optional(),
  merchant: z.string().min(1).optional(),
  /** Inclusive. */
  from: ISO_DATE.optional(),
  /** Inclusive. */
  to: ISO_DATE.optional(),
  /** Strictly greater, in major units. */
  amountOver: z.number().nonnegative().optional(),
});

/**
 * Which reading of the seeded ledger answers the question. `expenses` and
 * `net_worth` and `balance` name a figure oled publishes itself; the rest are
 * aggregates over the rows `transactions list` prints, which is the only
 * arithmetic the harness still does.
 */
const DERIVATION = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("count"), where: FILTER }),
  z.strictObject({ op: z.literal("sum"), where: FILTER }),
  z.strictObject({ op: z.literal("delta"), of: FILTER, minus: FILTER }),
  z.strictObject({ op: z.literal("top_merchant"), where: FILTER }),
  z.strictObject({ op: z.literal("balance"), account: z.string().min(1) }),
  z.strictObject({ op: z.literal("net_worth"), currency: CURRENCY }),
  z.strictObject({ op: z.literal("expenses"), from: ISO_DATE, to: ISO_DATE, currency: CURRENCY }),
  z.strictObject({ op: z.literal("expenses_by_currency"), from: ISO_DATE, to: ISO_DATE }),
]);

/**
 * What the answer must look like, with no value in it. Strict, so a golden
 * value left behind in the fixture fails the load instead of being ignored by
 * a harness that no longer reads one.
 */
const SHAPE = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("count") }),
  z.strictObject({ kind: z.literal("money"), unit: CURRENCY, tolerance: TOLERANCE }),
  z.strictObject({ kind: z.literal("number"), tolerance: TOLERANCE }),
  z.strictObject({ kind: z.literal("string") }),
  z.strictObject({ kind: z.literal("per_currency"), tolerance: TOLERANCE }),
]);

const QUESTION = z.strictObject({
  id: z.string().min(1),
  /** Verbatim what the model is asked; nothing is appended at run time. */
  prompt: z.string().min(1),
  shape: SHAPE,
  derivation: DERIVATION,
  extraSeed: z.literal("paging").optional(),
});

const QUESTIONS = z.strictObject({ note: z.string().min(1), cases: z.array(QUESTION).min(1) });

export type RowFilter = z.infer<typeof FILTER>;
export type Derivation = z.infer<typeof DERIVATION>;
export type GoldenShape = z.infer<typeof SHAPE>;

/** A shape with the ledger's own answer in it: the one thing a run is scored against. */
export type Golden =
  | { kind: "count"; value: number }
  | { kind: "money"; value: number; unit: string; tolerance?: number }
  | { kind: "number"; value: number; tolerance?: number }
  | { kind: "string"; value: string }
  | { kind: "per_currency"; perCurrency: Record<string, number>; tolerance?: number };

export interface QueryQuestion extends EvalCase {
  prompt: string;
  shape: GoldenShape;
  derivation: Derivation;
  extraSeed?: "paging";
  /** Resolved at load time so `prepare` reads no fixture from inside a sandbox. */
  rows: SeedRow[];
}

/** A question the seeded ledger has answered; the shape is spent once it is filled. */
export interface QueryCase extends Omit<QueryQuestion, "shape"> {
  golden: Golden;
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
 * prompt does not carry the sentence its golden kind calls for. q09 was scored
 * wrong for exactly this — it asked for a merchant and the model wrote a
 * sentence, because the only instruction it had about `answer` said "a one-line
 * summary".
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
export function expectationGap(kase: {
  id: string;
  prompt: string;
  shape: { kind: Golden["kind"] };
}): string | null {
  const wanted = ANSWER_EXPECTATION[kase.shape.kind];
  if (wanted === null || kase.prompt.includes(wanted)) return null;
  return `${kase.id} (${kase.shape.kind}) must end with ${JSON.stringify(wanted)}`;
}

export function loadQueryQuestions(fixturesDir: string): Result<QueryQuestion[]> {
  const dir = join(fixturesDir, "query");
  const questions = readQuestions(join(dir, "questions.json"));
  if (!questions.ok) return questions;

  const seed = readRows(join(dir, "seed.ndjson"));
  if (!seed.ok) return seed;

  const paging = readRows(join(dir, "paging-rows.ndjson"));
  if (!paging.ok) return paging;

  const cases: QueryQuestion[] = questions.value.cases.map((question) => ({
    ...question,
    rows: question.extraSeed ? [...seed.value, ...paging.value] : seed.value,
  }));

  // Costs no ledger and no spend: a question that does not say where its answer
  // goes scores the model's reading of the tool description rather than its work.
  const unstated = cases.map(expectationGap).filter((line) => line !== null);
  if (unstated.length === 0) return { ok: true, value: cases };
  return {
    ok: false,
    error: `a query question does not state what its answer must look like: ${unstated.join("; ")}`,
  };
}
