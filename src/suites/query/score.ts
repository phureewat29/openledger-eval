import { minorUnits } from "../../core/money.js";
import { gradeOf, type AssertionResult, type CaseGrade, type SubmittedAnswer } from "../types.js";
import { describeGolden, type Golden, type QueryCase } from "./goldens.js";

// The answer as submitted against the golden the fixture derived. Nothing here
// reads the model's prose: an answer arrives through `submit_answer` or not at all.

const MONEY_TOLERANCE = 0.01;

const UNSUBMITTED = "no answer submitted";

function money(amount: number): string {
  return amount.toFixed(2);
}

function within(got: number, want: number, tolerance: number): boolean {
  return Math.abs(minorUnits(got) - minorUnits(want)) <= minorUnits(tolerance);
}

function sameUnit(got: string | undefined, want: string): boolean {
  return got !== undefined && got.trim().toLowerCase() === want.toLowerCase();
}

function normalizeCurrencies(totals: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(totals).map(([currency, amount]) => [currency.trim().toUpperCase(), amount]),
  );
}

function currencyList(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "no currency totals";
  return entries.map(([currency, amount]) => `${currency} ${money(amount)}`).join(", ");
}

function matchesPerCurrency(
  want: Record<string, number>,
  submitted: SubmittedAnswer,
  tolerance: number,
): boolean {
  // A fused total alongside the split is the trap: one number for two currencies.
  if (submitted.value !== undefined || submitted.perCurrency === undefined) return false;

  const got = normalizeCurrencies(submitted.perCurrency);
  const wanted = Object.keys(want);
  if (wanted.length !== Object.keys(got).length) return false;
  return wanted.every((currency) => {
    const amount = got[currency];
    const target = want[currency];
    return amount !== undefined && target !== undefined && within(amount, target, tolerance);
  });
}

/** One entry per golden kind: a new kind fails to compile until it can be scored. */
const CORRECT: {
  [K in Golden["kind"]]: (golden: Extract<Golden, { kind: K }>, got: SubmittedAnswer) => boolean;
} = {
  count: (golden, got) => got.value !== undefined && Number.isInteger(got.value) && got.value === golden.value,
  money: (golden, got) =>
    got.value !== undefined &&
    within(got.value, golden.value, golden.tolerance ?? MONEY_TOLERANCE) &&
    sameUnit(got.unit, golden.unit),
  number: (golden, got) =>
    got.value !== undefined && within(got.value, golden.value, golden.tolerance ?? MONEY_TOLERANCE),
  string: (golden, got) => got.answer.trim().toLowerCase() === golden.value.trim().toLowerCase(),
  per_currency: (golden, got) =>
    matchesPerCurrency(golden.perCurrency, got, golden.tolerance ?? MONEY_TOLERANCE),
};

function isCorrect(golden: Golden, got: SubmittedAnswer): boolean {
  const check = CORRECT[golden.kind] as (g: Golden, a: SubmittedAnswer) => boolean;
  return check(golden, got);
}

function wantOf(golden: Golden): string {
  const described = describeGolden(golden);
  if (golden.kind === "per_currency") return `${described}, and no single fused total`;
  if (golden.kind === "count" || golden.kind === "string") return described;
  return `${described} ±${money(golden.tolerance ?? MONEY_TOLERANCE)}`;
}

function numberGot(got: SubmittedAnswer, needsUnit: boolean): string {
  if (got.value === undefined) return "no numeric value";
  if (!needsUnit) return money(got.value);
  return got.unit ? `${money(got.value)} ${got.unit}` : `${money(got.value)} (no unit)`;
}

function perCurrencyGot(got: SubmittedAnswer): string {
  if (got.perCurrency === undefined) return "no per-currency totals";
  const split = currencyList(normalizeCurrencies(got.perCurrency));
  return got.value === undefined ? split : `${split}, fused into ${money(got.value)}`;
}

/** One entry per golden kind, so the evidence always speaks the golden's own language. */
const GOT: { [K in Golden["kind"]]: (got: SubmittedAnswer) => string } = {
  count: (got) => (got.value === undefined ? "no numeric value" : String(got.value)),
  money: (got) => numberGot(got, true),
  number: (got) => numberGot(got, false),
  string: (got) => JSON.stringify(got.answer.trim()),
  per_currency: perCurrencyGot,
};

function gotOf(golden: Golden, got: SubmittedAnswer | null): string {
  return got === null ? UNSUBMITTED : GOT[golden.kind](got);
}

function answerCheck(golden: Golden, submitted: SubmittedAnswer | null): AssertionResult {
  return {
    id: "answer_correct",
    label: "answer",
    passed: submitted !== null && isCorrect(golden, submitted),
    evidence: { want: wantOf(golden), got: gotOf(golden, submitted) },
  };
}

export function gradeQuery(kase: QueryCase, submitted: SubmittedAnswer | null): CaseGrade {
  return gradeOf(kase.id, [
    {
      id: "submit_called",
      label: "answer submitted",
      passed: submitted !== null,
      evidence: {
        want: "one submit_answer call",
        got: submitted === null ? "the phase ended with no submit_answer call" : "an answer was submitted",
      },
    },
    answerCheck(kase.golden, submitted),
  ]);
}
