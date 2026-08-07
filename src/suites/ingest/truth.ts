import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod";
import { minorUnits } from "../../core/money.js";
import { tryExecute, type Result } from "../../core/result.js";

/**
 * What each statement says, read from the PDF once and checked in beside it as
 * fact. Reading a statement is the model's job, through oled; fact files never
 * enter the sandbox, so they cannot leak the answers.
 */

const GROUP = z.object({
  count: z.number().int().nonnegative(),
  /** Absolute total, so a refund or a payment is a positive number here. */
  total: z.number().nonnegative(),
});

const FACTS = z.object({
  /** The PDF this file describes; checked against the file it was loaded for. */
  statement: z.string().min(1),
  /** Where the numbers came from; required so a fact file cannot land without provenance. */
  note: z.string().min(1),
  currency: z.string().min(1),
  groups: z.object({ charges: GROUP, refunds: GROUP, payments: GROUP }),
  summary: z.object({
    previousBalance: z.number(),
    purchasesAndFees: z.number(),
    refundsAndCredits: z.number(),
    paymentsReceived: z.number(),
    totalAmountDue: z.number(),
  }),
});

export type StatementFacts = z.infer<typeof FACTS>;

/** A total the model reproduces to the cent. */
export const MONEY_TOLERANCE = 0.01;

/** Net worth also carries whatever rounding the model's own arithmetic added. */
export const NET_WORTH_TOLERANCE = 1;

export const MAX_UNCATEGORIZED_RATIO = 0.05;

const PDF_SUFFIX = /\.pdf$/i;

/** The 1-1 link: `card-statement-2026-05.pdf` → `card-statement-2026-05.expected.json`. */
function factsPathFor(pdfPath: string): string {
  return `${pdfPath.replace(PDF_SUFFIX, "")}.expected.json`;
}

export function moneyMatches(got: number, want: number, tolerance: number): boolean {
  return Math.abs(minorUnits(got) - minorUnits(want)) <= minorUnits(tolerance);
}

export function expectedRows(facts: StatementFacts): number {
  const { charges, refunds, payments } = facts.groups;
  return charges.count + refunds.count + payments.count;
}

/**
 * Payments cancel out (liability against asset, both inside the ledger), but the
 * previous balance does not: `ingest done --closing-balance` verifies the card
 * account against the statement's own closing balance and refuses on a mismatch,
 * so the only way to reach that figure is to book the opening balance first
 * (through equity). A ledger that passes `file_closed` therefore always carries
 * the previous balance, and net worth has to account for it too.
 */
export function expectedNetWorth(facts: StatementFacts): number {
  const { charges, refunds } = facts.groups;
  return -(minorUnits(facts.summary.previousBalance) + minorUnits(charges.total) - minorUnits(refunds.total)) / 100;
}

/**
 * Every way one statement's groups and its own summary box can disagree. The
 * closing balance is the arithmetic that ties them together, so it is checked too.
 */
function reconcile(facts: StatementFacts): string[] {
  const { charges, refunds, payments } = facts.groups;
  const box = facts.summary;
  const disagreements: string[] = [];
  const compare = (label: string, group: number, stated: number): void => {
    if (minorUnits(group) === minorUnits(stated)) return;
    disagreements.push(`${label}: groups say ${group.toFixed(2)}, the box says ${stated.toFixed(2)}`);
  };

  compare("charges", charges.total, box.purchasesAndFees);
  compare("refunds", refunds.total, box.refundsAndCredits);
  compare("payments", payments.total, box.paymentsReceived);

  const due =
    minorUnits(box.previousBalance) +
    minorUnits(charges.total) -
    minorUnits(refunds.total) -
    minorUnits(payments.total);
  if (due !== minorUnits(box.totalAmountDue)) {
    disagreements.push(
      `total amount due: the rows add up to ${(due / 100).toFixed(2)}, the box says ${box.totalAmountDue.toFixed(2)}`,
    );
  }
  return disagreements;
}

export function loadStatementFacts(pdfPath: string): Result<StatementFacts> {
  const path = factsPathFor(pdfPath);
  const read = tryExecute(() => readFileSync(path, "utf8"));
  if (!read.ok) return { ok: false, error: `cannot read ${path}: ${read.error}` };

  const json = tryExecute(() => JSON.parse(read.value) as unknown);
  if (!json.ok) return { ok: false, error: `${path} is not valid JSON: ${json.error}` };

  const parsed = FACTS.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };

  const facts = parsed.data;
  const pdf = basename(pdfPath);
  if (facts.statement !== pdf) {
    return { ok: false, error: `${path} describes ${facts.statement}, not ${pdf}` };
  }

  const disagreements = reconcile(facts);
  if (disagreements.length > 0) {
    return { ok: false, error: `${path} disagrees with itself: ${disagreements.join("; ")}` };
  }
  return { ok: true, value: facts };
}
