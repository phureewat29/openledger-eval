import { adjustmentsAccount, netWorthMinor, uncategorizedAccount } from "../../core/accounts.js";
import type { LedgerPosting, LedgerProbe } from "../../oled/ledger.js";
import { exitTally, rejectedTotal } from "../../report/counters.js";
import {
  gradeOf,
  notApplicable,
  type AssertionResult,
  type CaseGrade,
  type RunCounters,
  type RunMetrics,
} from "../types.js";
import { RESOLVE_MAX_CALLS, type RecordCase } from "./cases.js";

// What the text said against what oled holds. Nothing here reads the model's
// prose: the ledger is the answer, and a run is judged only by the one it left.
//
// The journey is reported beside the checks and never graded, per the owner: how
// many turns it took, what exited nonzero, what was refused and what was tried
// twice say how hard the CLI was to use, not whether the books came out right.

/** How many differences each side of a multiset comparison lists before the evidence stops naming them. */
const EVIDENCE_SAMPLE = 3;

/** Both sides are minor units, so a decimal from oled never meets a float here. */
function money(minor: number): string {
  return (minor / 100).toFixed(2);
}

function check(
  id: string,
  label: string,
  passed: boolean,
  want: string,
  got: string,
): AssertionResult {
  return { id, label, passed, evidence: { want, got } };
}

/** `na` keeps a figure out of the pass rate; the want and got columns still carry it. */
function reported(id: string, label: string, want: string, got: string): AssertionResult {
  return { id, label, passed: false, na: true, evidence: { want, got } };
}

/**
 * Without `--file`, `ingest commit` mints a fresh id per row, so a batch
 * re-committed after a partial failure posts everything a second time. Exact
 * equality is the only thing that catches it, and the evidence says so plainly.
 */
function rowsPosted(kase: RecordCase, probe: LedgerProbe): AssertionResult {
  const want = kase.expected.rowCount;
  const got = probe.postedRows;
  const excess =
    got > want
      ? `, which is ${got - want} more than the text holds: rows were posted more than once`
      : "";
  return check("rows_posted", "posted rows", got === want, `${want} rows`, `${got} rows${excess}`);
}

/** Reads as a row a person can find in the text: when, from where to where, how much. */
function postingKey(posting: LedgerPosting): string {
  return `${posting.date} ${posting.debit} <- ${posting.credit} ${money(posting.amountMinor)}`;
}

function tally(postings: LedgerPosting[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const posting of postings) {
    const key = postingKey(posting);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Where `have` falls short of `want`, sorted, so the same ledger always reads the same way. */
function shortOf(want: Map<string, number>, have: Map<string, number>): string[] {
  return [...want]
    .map(([key, count]) => ({ key, gap: count - (have.get(key) ?? 0) }))
    .filter(({ gap }) => gap > 0)
    .map(({ key, gap }) => (gap === 1 ? key : `${key} ×${gap}`))
    .toSorted();
}

function sample(lines: string[]): string {
  const rest = lines.length - EVIDENCE_SAMPLE;
  const shown = lines.slice(0, EVIDENCE_SAMPLE).join(", ");
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Every row as one multiset of (date, debit, credit, amount). Balances and a row
 * count are both blind to three real failures, and this is the only check that
 * sees any of them: two rows sharing accounts and amount on different days,
 * posted on one day or merged into their sum; a row split in two; and rows paid
 * from the wrong account in offsetting pairs, which leaves every balance tying
 * exactly while the ledger says something the text never said.
 *
 * Descriptions are deliberately not scored, and should not be: they are free text
 * a model may legitimately reword, while the date, the pair of accounts and the
 * amount pin a row without grading prose.
 */
function rowsMatch(kase: RecordCase, probe: LedgerProbe): AssertionResult {
  const id = "rows_match";
  const label = "each row's date, accounts and amount";
  const total = kase.expected.postings.length;
  const cut = probe.truncated;
  if (cut) {
    return notApplicable(id, label, `the listing stopped at ${cut.returned} of ${cut.total} rows`);
  }

  const wanted = tally(kase.expected.postings);
  const held = tally(probe.postings);
  const missing = shortOf(wanted, held);
  const unexpected = shortOf(held, wanted);
  const differences = [
    missing.length > 0 ? `missing ${sample(missing)}` : null,
    unexpected.length > 0 ? `unexpected ${sample(unexpected)}` : null,
  ].filter((part): part is string => part !== null);
  const matched = differences.length === 0;
  return check(
    id,
    label,
    matched,
    `${total} rows as the text states them`,
    matched ? `all ${total} match` : differences.join("; "),
  );
}

/**
 * One check per chart account, which is where a direction error surfaces: money
 * booked the wrong way round leaves the count right and the balances wrong. An
 * account oled never opened holds nothing, so it reads as a zero balance.
 */
function balanceChecks(kase: RecordCase, probe: LedgerProbe): AssertionResult[] {
  return kase.accounts.map((account) => {
    const want = kase.expected.balancesMinor[account.id] ?? 0;
    const got = probe.balancesMinor[account.id];
    return check(
      `balance:${account.id}`,
      `balance ${account.id}`,
      (got ?? 0) === want,
      money(want),
      got === undefined ? "0.00 (no such account in the ledger)" : money(got),
    );
  });
}

/** An account and everything under it: money parked one level down is still parked. */
function subtreeMinor(probe: LedgerProbe, root: string): number {
  return sumSubtree(probe.balancesMinor, root);
}

function sumSubtree(figures: Record<string, number>, root: string): number {
  return Object.entries(figures)
    .filter(([id]) => id === root || id.startsWith(`${root}:`))
    .reduce((total, [, minor]) => total + minor, 0);
}

/** Money under the fallback account, children included, is a row that fell through the resolver. */
function uncategorizedCheck(kase: RecordCase, probe: LedgerProbe): AssertionResult {
  const root = uncategorizedAccount(kase.currency);
  const minor = subtreeMinor(probe, root);
  const rows = probe.uncategorizedRows;
  return check(
    "nothing_uncategorized",
    `nothing in ${root}`,
    minor === 0,
    "0.00",
    rows === 0 ? money(minor) : `${money(minor)} across ${rows} rows`,
  );
}

/**
 * The counterpart to the fallback account: `accounts adjust` will set any
 * balance to any figure and posts the difference here, so a run that created the
 * chart, adjusted every account into place and recorded nothing would satisfy
 * every balance check.
 *
 * Read gross, never the balance. For any balanced set of rows the debit-normal
 * expected balances sum to exactly the credit-normal ones, so adjusting a whole
 * chart into place moves equal amounts each way through this account and its
 * net balance lands back on zero. Only debits plus credits shows the money went
 * through at all.
 */
function adjustmentsCheck(kase: RecordCase, probe: LedgerProbe): AssertionResult {
  const root = adjustmentsAccount(kase.currency);
  const minor = sumSubtree(probe.grossMinor, root);
  return check("nothing_adjusted", `nothing posted through ${root}`, minor === 0, "0.00", money(minor));
}

/**
 * Read off the probe's balances rather than oled's own net worth, which reports
 * no single total once a second ledger exists — and a case whose currency has to
 * be opened always ends with two.
 */
function ledgerNetWorthMinor(probe: LedgerProbe, currency: string): number {
  const head = `${currency.toLowerCase()}:`;
  const scoped = Object.entries(probe.balancesMinor).filter(([id]) => id.startsWith(head));
  return netWorthMinor(Object.fromEntries(scoped));
}

/**
 * The journey, and the one figure that sums the balances above it. The cap counts
 * model turns rather than oled calls: one turn can carry several calls, which is
 * how a case with more rows than turns is meant to be finished. `llmCalls` spans
 * the whole run, so the budget it is read against is both phases' caps together;
 * one phase's cap would report a run inside its budget as over it.
 */
function reportedLines(
  kase: RecordCase,
  probe: LedgerProbe,
  metrics: RunMetrics,
  counters: RunCounters,
): AssertionResult[] {
  return [
    reported(
      "turns_used",
      "turns used",
      `up to ${kase.maxCalls + RESOLVE_MAX_CALLS} (${kase.maxCalls} recording, ${RESOLVE_MAX_CALLS} resolving)`,
      `${metrics.llmCalls} turns, ${metrics.toolCalls} oled calls`,
    ),
    reported("nonzero_exits", "nonzero exits", "reported, not scored", exitTally(counters)),
    reported("refused_calls", "refused calls", "reported, not scored", String(rejectedTotal(counters))),
    reported(
      "repeated_commands",
      "repeated commands",
      "reported, not scored",
      String(counters.repeatedCommands),
    ),
    reported(
      "net_worth",
      `net worth in ${kase.currency}`,
      money(kase.expected.netWorthMinor),
      money(ledgerNetWorthMinor(probe, kase.currency)),
    ),
  ];
}

export function gradeRecord(
  kase: RecordCase,
  probe: LedgerProbe,
  metrics: RunMetrics,
  counters: RunCounters,
): CaseGrade {
  return gradeOf(kase.id, [
    rowsPosted(kase, probe),
    rowsMatch(kase, probe),
    ...balanceChecks(kase, probe),
    uncategorizedCheck(kase, probe),
    adjustmentsCheck(kase, probe),
    // Deferred counts as open: a question put off is a decision the run declined to
    // make, and deferring every one of them would otherwise close this check.
    check(
      "questions_closed",
      "questions closed",
      probe.questionsOpen === 0 && probe.questionsDeferred === 0,
      "0 open, 0 deferred",
      `${probe.questionsOpen} open, ${probe.questionsDeferred} deferred`,
    ),
    ...reportedLines(kase, probe, metrics, counters),
  ]);
}
