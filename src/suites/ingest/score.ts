import { groupedRows, type LedgerProbe } from "../../oled/ledger.js";
import { gradeOf, notApplicable, type AssertionResult, type CaseGrade } from "../types.js";
import {
  expectedNetWorth,
  expectedRows,
  moneyMatches,
  MAX_UNCATEGORIZED_RATIO,
  MONEY_TOLERANCE,
  NET_WORTH_TOLERANCE,
  type StatementFacts,
} from "./truth.js";

// What the statement says against what oled holds. Nothing here reads the
// model's prose: a run is judged only by the ledger it left behind.

const GROUPS = ["charges", "refunds", "payments"] as const;

function money(amount: number): string {
  return amount.toFixed(2);
}

function within(amount: number, tolerance: number): string {
  return `${money(amount)} ±${money(tolerance)}`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
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

/** `tallyMoney` reports no total once rows span two currency ledgers, and a bare 0.00 would read as a miscount. */
function totalGot(got: { count: number; total: number }, want: number): string {
  if (got.count > 0 && got.total === 0 && want !== 0) {
    return "0.00 (no single-currency total: the rows span more than one ledger)";
  }
  return money(got.total);
}

function groupChecks(facts: StatementFacts, probe: LedgerProbe): AssertionResult[] {
  return GROUPS.flatMap((group) => {
    const want = facts.groups[group];
    const got = probe.money[group];
    return [
      check(
        `${group}_count`,
        `${group}: rows`,
        got.count === want.count,
        String(want.count),
        String(got.count),
      ),
      check(
        `${group}_total`,
        `${group}: total`,
        moneyMatches(got.total, want.total, MONEY_TOLERANCE),
        within(want.total, MONEY_TOLERANCE),
        totalGot(got, want.total),
      ),
    ];
  });
}

/**
 * `rows_posted` compares against `groupedRows`, which only counts rows `groupOf`
 * (ledger.ts) can place in charges, refunds or payments. The opening-balance row
 * runs debit equity / credit liability, a pair `groupOf` returns null for, so it
 * posts but never enters a group — invisible to that check. Reported rather than
 * scored: it isn't a defect in the run, it's a row the statement's own groups
 * were never going to see.
 */
function unclassifiedRowsCheck(probe: LedgerProbe): AssertionResult {
  const unclassified = probe.postedRows - groupedRows(probe.money);
  return notApplicable(
    "unclassified_rows",
    "rows outside the statement's groups",
    `${unclassified} of ${probe.postedRows}, usually the opening balance (booked through equity, which groupOf assigns to no group)`,
  );
}

/** A ratio over no rows says nothing about categorizing, so it is not scored either way. */
function uncategorizedCheck(probe: LedgerProbe): AssertionResult {
  const id = "uncategorized_ratio";
  const label = "uncategorized share";
  if (probe.postedRows === 0) return notApplicable(id, label, "no rows posted");
  const ratio = probe.uncategorizedRows / probe.postedRows;
  return check(
    id,
    label,
    ratio <= MAX_UNCATEGORIZED_RATIO,
    `≤ ${percent(MAX_UNCATEGORIZED_RATIO)}`,
    `${percent(ratio)} (${probe.uncategorizedRows} of ${probe.postedRows})`,
  );
}

export function gradeIngest(
  caseId: string,
  facts: StatementFacts,
  probe: LedgerProbe,
): CaseGrade {
  const netWorth = expectedNetWorth(facts);
  return gradeOf(caseId, [
    check(
      "rows_posted",
      "posted rows",
      groupedRows(probe.money) === expectedRows(facts),
      String(expectedRows(facts)),
      String(groupedRows(probe.money)),
    ),
    ...groupChecks(facts, probe),
    uncategorizedCheck(probe),
    unclassifiedRowsCheck(probe),
    // Deferring a question postpones it, so counting only the open ones would
    // let `questions defer` close this check without answering anything.
    check(
      "questions_closed",
      "open questions",
      probe.questionsOpen === 0 && probe.questionsDeferred === 0,
      "0 open, 0 deferred",
      `${probe.questionsOpen} open, ${probe.questionsDeferred} deferred`,
    ),
    check(
      "file_ingested",
      "statement ingested",
      probe.filesIngested >= 1,
      "≥ 1 file",
      `${probe.filesIngested} files`,
    ),
    check(
      "file_closed",
      "statement closed",
      probe.filesPending === 0,
      "0 pending",
      `${probe.filesPending} pending`,
    ),
    check(
      "net_worth",
      "net worth",
      moneyMatches(probe.netWorth, netWorth, NET_WORTH_TOLERANCE),
      within(netWorth, NET_WORTH_TOLERANCE),
      money(probe.netWorth),
    ),
  ]);
}
