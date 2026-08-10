import { mapValues } from "es-toolkit";
import * as z from "zod";
import { ACCOUNT_TYPES, uncategorizedAccount } from "../core/accounts.js";
import { minorUnits } from "../core/money.js";
import type { Result } from "../core/result.js";
import { runNdjson, type OpenLedgerRunner } from "./command.js";

/**
 * Reads the ledger back through the same CLI the model uses, so the scorecard
 * judges what oled holds, not what the model claimed. Every read passes
 * --no-redact: redaction is on by default and its numeric PII patterns rewrite
 * innocuous text, which would make a reading depend on wording.
 */

/** The three groups a card statement's own totals are printed as. */
export const MONEY_GROUPS = ["charges", "refunds", "payments"] as const;
type MoneyGroup = (typeof MONEY_GROUPS)[number];

interface LedgerGroup {
  count: number;
  /** Absolute total, so a refund and a payment are positive here, as on the statement. */
  total: number;
}

type LedgerMoney = Record<MoneyGroup, LedgerGroup>;

export function groupedRows(money: LedgerMoney): number {
  return money.charges.count + money.refunds.count + money.payments.count;
}

/** `transactions list` hit its limit: every reading taken from the listing is short. */
interface ListTruncation {
  limit: number;
  total: number;
  returned: number;
}

/**
 * Signed integer minor units per account id, zero-balance accounts included.
 * Minor units are the only form on offer: oled prints balances as decimal JSON
 * numbers, and a caller with no decimal in hand cannot compare floats by
 * accident. Turn an expected decimal into this space with `minorUnits`.
 */
export type AccountBalancesMinor = Record<string, number>;

/**
 * What an account took in both directions, added together, in minor units. A
 * balance nets debits against credits, so it reads zero both for an account
 * nothing touched and for one that took equal amounts each way. Only the gross
 * figure tells those apart, which is what a run that moved money through an
 * account and cancelled it out depends on.
 */
export type AccountGrossMinor = Record<string, number>;

/**
 * One row reduced to the four facts that make it the row it is. The account pair
 * belongs here because a set of balances cannot tell a correct ledger from one
 * whose rows were paid from the wrong accounts in offsetting pairs: swap two
 * credits between rows of matching totals and every balance still ties.
 * Descriptions are deliberately absent — a model may reword them.
 */
export interface LedgerPosting {
  date: string;
  debit: string;
  credit: string;
  amountMinor: number;
}

export interface LedgerProbe {
  filesIngested: number;
  /** Files oled still holds as pending, i.e. never closed with `ingest done`. */
  filesPending: number;
  postedRows: number;
  uncategorizedRows: number;
  questionsOpen: number;
  questionsDeferred: number;
  netWorth: number;
  /** null when the whole ledger fit in one listing, which is the expected case. */
  truncated: ListTruncation | null;
  /** Ledger-wide, not only linked rows: unlinked money would still corrupt a total. */
  money: LedgerMoney;
  /** Every live row, so a suite can compare the set it expected against the set oled holds. */
  postings: LedgerPosting[];
  /** Each account's own balance, never its children's: oled sums one account's legs. */
  balancesMinor: AccountBalancesMinor;
  /** Debits plus credits per account, so money that passed through and cancelled still shows. */
  grossMinor: AccountGrossMinor;
}

const STATUS = z.object({
  db: z.object({ reachable: z.boolean(), error: z.string().nullable() }),
  counts: z.object({ transactions: z.number() }).nullable(),
  files: z.object({ ingested: z.number(), pending: z.number() }).nullable(),
  questions: z.object({ open: z.number(), deferred: z.number() }).nullable(),
  net_worth: z.object({ net_worth: z.record(z.string(), z.number()) }).nullable(),
});

/** The one authority on a listed row's shape; a reader wanting more of the row extends it. */
export const TRANSACTION_ROW = z.object({
  date: z.string(),
  debit_account_id: z.string(),
  credit_account_id: z.string(),
  amount: z.number(),
  source_file_id: z.string().nullable().optional(),
  void_of: z.string().nullable().optional(),
});

/** The summary `transactions list` closes with; `has_more` is how a capped read admits it. */
export const LIST_SUMMARY = z.object({
  type: z.literal("summary"),
  total: z.number(),
  returned: z.number(),
  has_more: z.boolean(),
  limit: z.number(),
});

/** `balance` arrives already signed by the account's normal side: debits minus
 *  credits for asset and expense, credits minus debits for the other three. */
const ACCOUNT = z.object({
  id: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  balance: z.number(),
  // Gross, unsigned, and the only way to see money that passed through an
  // account and cancelled out: a net balance of zero cannot tell an untouched
  // account from one that took equal debits and credits.
  debits_posted: z.number(),
  credits_posted: z.number(),
});

/** `accounts list` takes no limit and never pages, so its terminator only says how many it wrote. */
const ACCOUNTS_SUMMARY = z.object({
  type: z.literal("summary"),
  total: z.number(),
  returned: z.number(),
});

type Row = z.infer<typeof TRANSACTION_ROW>;
export type StatusReport = z.infer<typeof STATUS>;

/** The CLI's own maximum for `transactions list --limit`; asking for more is a usage error. */
export const LIST_LIMIT = 500;

function rootOf(accountId: string): string {
  return accountId.split(":")[1] ?? "";
}

function ledgerOf(accountId: string): string {
  return accountId.split(":")[0] ?? "";
}

/** Read against the account's own currency head, so it matches whichever ledger the row posted into. */
function isUncategorized(row: Row): boolean {
  return (
    row.debit_account_id.startsWith(uncategorizedAccount(ledgerOf(row.debit_account_id))) ||
    row.credit_account_id.startsWith(uncategorizedAccount(ledgerOf(row.credit_account_id)))
  );
}

/** Classifies by direction, not sign; an opening balance runs through equity,
 *  so it belongs to no group. */
function groupOf(row: Row): MoneyGroup | null {
  const debit = rootOf(row.debit_account_id);
  const credit = rootOf(row.credit_account_id);
  if (debit === "expense" && credit === "liability") return "charges";
  if (debit === "liability" && credit === "expense") return "refunds";
  if (debit === "liability" && credit === "asset") return "payments";
  return null;
}

/** Totals come back 0 across more than one ledger, same rule as `soleLedgerTotal`.
 *  Ledger membership is read off the debit account's id. */
export function tallyMoney(rows: Row[]): LedgerMoney {
  const tallies = Object.fromEntries(MONEY_GROUPS.map((group) => [group, { count: 0, minor: 0 }])) as Record<
    MoneyGroup,
    { count: number; minor: number }
  >;
  const ledgers = new Set<string>();
  for (const row of rows) {
    const group = groupOf(row);
    if (group === null) continue;
    ledgers.add(ledgerOf(row.debit_account_id));
    tallies[group].count += 1;
    tallies[group].minor += minorUnits(row.amount);
  }
  return mapValues(tallies, ({ count, minor }) => ({
    count,
    total: ledgers.size > 1 ? 0 : minor / 100,
  }));
}

function toPosting(row: Row): LedgerPosting {
  return {
    date: row.date,
    debit: row.debit_account_id,
    credit: row.credit_account_id,
    amountMinor: minorUnits(row.amount),
  };
}

function liveRows(records: Record<string, unknown>[]): Row[] {
  return records.flatMap((record) => {
    const parsed = TRANSACTION_ROW.safeParse(record);
    if (!parsed.success || parsed.data.void_of) return [];
    return [parsed.data];
  });
}

/** The first record a schema accepts; what precedes or follows it in the listing is not this caller's concern. */
function firstParsed<T>(records: Record<string, unknown>[], schema: z.ZodType<T>): T | null {
  for (const record of records) {
    const parsed = schema.safeParse(record);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Absent on an empty listing, and null unless the cap actually bit. */
function truncationOf(records: Record<string, unknown>[]): ListTruncation | null {
  const summary = firstParsed(records, LIST_SUMMARY);
  return summary?.has_more ? { limit: summary.limit, total: summary.total, returned: summary.returned } : null;
}

/** How many accounts oled says it wrote, or null when the terminator is missing. */
function accountsWritten(records: Record<string, unknown>[]): number | null {
  return firstParsed(records, ACCOUNTS_SUMMARY)?.returned ?? null;
}

/**
 * Accounts are taken by their five real types rather than by excluding the
 * literal "summary" the terminator carries in the same `type` field, so a row
 * shape oled adds later is skipped instead of read as an account. Counting the
 * kept rows against the terminator turns that silence into a failed probe.
 */
export function readBalances(
  records: Record<string, unknown>[],
): Result<{ balancesMinor: AccountBalancesMinor; grossMinor: AccountGrossMinor }> {
  const balances: AccountBalancesMinor = {};
  const gross: AccountGrossMinor = {};
  for (const record of records) {
    const parsed = ACCOUNT.safeParse(record);
    if (!parsed.success) continue;
    balances[parsed.data.id] = minorUnits(parsed.data.balance);
    gross[parsed.data.id] = minorUnits(parsed.data.debits_posted) + minorUnits(parsed.data.credits_posted);
  }

  const written = accountsWritten(records);
  if (written === null) return { ok: false, error: "oled accounts list printed no summary row" };

  const read = Object.keys(balances).length;
  if (read !== written) {
    return {
      ok: false,
      error: `oled accounts list wrote ${written} accounts but ${read} were readable`,
    };
  }
  return { ok: true, value: { balancesMinor: balances, grossMinor: gross } };
}

/** Multiple ledgers means no one number to score, so totals come back 0 rather
 *  than a sum across units. */
function soleLedgerTotal(totals: Record<string, number> | undefined): number {
  const [only, ...rest] = Object.values(totals ?? {});
  return only !== undefined && rest.length === 0 ? only : 0;
}

export function readStatus(records: Record<string, unknown>[]): Result<StatusReport> {
  const parsed = STATUS.safeParse(records[0]);
  if (!parsed.success) {
    return {
      ok: false,
      error: `oled status output was unreadable: ${z.prettifyError(parsed.error)}`,
    };
  }
  if (!parsed.data.db.reachable) {
    return { ok: false, error: `database unreachable: ${parsed.data.db.error ?? "unknown reason"}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Three commands: `status` holds every count oled keeps, the transaction listing
 * holds the rows themselves, and the account listing holds the balances.
 */
export async function probeLedger(runner: OpenLedgerRunner): Promise<Result<LedgerProbe>> {
  const status = await runNdjson(runner, "oled status", ["status", "--no-redact", "--json"]);
  if (!status.ok) return status;

  const report = readStatus(status.value);
  if (!report.ok) return report;

  const listed = await runNdjson(runner, "oled transactions list", [
    "transactions",
    "list",
    "--limit",
    String(LIST_LIMIT),
    "--no-redact",
    "--json",
  ]);
  if (!listed.ok) return listed;

  const accounts = await runNdjson(runner, "oled accounts list", [
    "accounts",
    "list",
    "--no-redact",
    "--json",
  ]);
  if (!accounts.ok) return accounts;

  const balances = readBalances(accounts.value);
  if (!balances.ok) return balances;

  const rows = liveRows(listed.value);
  const { counts, files, questions, net_worth: netWorth } = report.value;
  return {
    ok: true,
    value: {
      filesIngested: files?.ingested ?? 0,
      filesPending: files?.pending ?? 0,
      postedRows: counts?.transactions ?? 0,
      uncategorizedRows: rows.filter(isUncategorized).length,
      questionsOpen: questions?.open ?? 0,
      questionsDeferred: questions?.deferred ?? 0,
      netWorth: soleLedgerTotal(netWorth?.net_worth),
      truncated: truncationOf(listed.value),
      money: tallyMoney(rows),
      postings: rows.map(toPosting),
      balancesMinor: balances.value.balancesMinor,
      grossMinor: balances.value.grossMinor,
    },
  };
}
