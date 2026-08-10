import { createTools } from "../../agent/tools.js";
import type { Result } from "../../core/result.js";
import { buildSystemPrompt } from "../adapter.js";
import type { Suite, SuiteContext, SuitePhase } from "../types.js";
import { loadRecordCases, RESOLVE_MAX_CALLS, type ChartAccount, type RecordCase } from "./cases.js";
import { gradeRecord } from "./score.js";

/**
 * Transactions arrive as text — a table, a note, a CSV export — and the ledger
 * they end up in is the answer. The prompt hands over the text, the chart of
 * accounts and the ask, and says nothing about `oled`: SKILL.md and `--help`
 * are the surface under test, so any usage advice here would measure this file.
 */

const RECORD_ID = "record";

const RECORD_TITLE = "Record the transactions";

const INSTRUCTION =
  "Record every one of the transactions below in my ledger. The accounts they belong to are listed after them.";

/**
 * A second turn at the ledger, because recording well and cleaning up after
 * yourself are two different asks and one phase scores them as one. A run that
 * hits a refusal, works out what the ledger needs and leaves questions behind
 * would otherwise finish below a run that never met the problem — the case whose
 * whole point is the recovery would punish taking it. The bar is stated outright
 * rather than left to be guessed: what the scorecard wants closed is what the
 * prompt asks for.
 */
const RESOLVE: SuitePhase = {
  id: "resolve",
  title: "Resolve what the ledger flagged",
  maxCalls: RESOLVE_MAX_CALLS,
  prompt:
    "Where the text did not settle something, my ledger will have flagged it: a question waiting on an answer, or a row it could not put anywhere. Settle all of it. Nothing should be left open, deferred or uncategorized when you are done.",
};

// Hashed into the suite fingerprint: the fixed half of the ask. The per-case
// statement text is not here — it is hashed by its own bytes, as one of the
// record fixture files.
export const PROMPTS = [INSTRUCTION, RESOLVE.prompt];

function chartLines(accounts: ChartAccount[]): string {
  return accounts.map((account) => `- ${account.id} — ${account.name}`).join("\n");
}

function promptFor(kase: RecordCase): string {
  return [
    INSTRUCTION,
    "## The transactions",
    kase.inputText.trim(),
    "## My accounts",
    chartLines(kase.accounts),
  ].join("\n\n");
}

/**
 * Nothing is seeded and no account is created: the text is the only source, and
 * opening what it needs is the model's work. For a case in a currency the
 * sandbox has no ledger for, that work starts with a refused commit.
 */
function prepare(_ctx: SuiteContext, kase: RecordCase): Promise<Result<SuitePhase[]>> {
  return Promise.resolve({
    ok: true,
    value: [
      { id: RECORD_ID, title: RECORD_TITLE, maxCalls: kase.maxCalls, prompt: promptFor(kase) },
      RESOLVE,
    ],
  });
}

export const recordSuite: Suite<RecordCase> = {
  id: "record",
  cases: loadRecordCases,
  prepare,
  systemPrompt: buildSystemPrompt,
  // No submit_answer: there is nothing to say that the ledger does not already say.
  tools: (ctx) => createTools(ctx.runner),
  score: ({ kase, probe, metrics, counters }) => gradeRecord(kase, probe, metrics, counters),
};
