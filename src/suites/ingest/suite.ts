import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createTools } from "../../agent/tools.js";
import type { Result } from "../../core/result.js";
import { seedFiles } from "../../sandbox/workspace.js";
import { buildSystemPrompt } from "../adapter.js";
import type { EvalCase, Suite, SuiteContext, SuitePhase } from "../types.js";
import { gradeIngest } from "./score.js";
import { loadStatementFacts, type StatementFacts } from "./truth.js";

export interface IngestCase extends EvalCase {
  pdf: string;
  facts: StatementFacts;
}

const STATEMENT = "card-statement-2026-05.pdf";
/** Under the sandbox data dir, where a person would keep downloaded statements. */
const SEED_DIR = "bank";

const INGEST: SuitePhase = {
  id: "ingest",
  title: "Ingest the statement",
  maxCalls: 32,
  prompt: "Ingest my new statements. The statement is password-protected; the password is: password.",
};

const RESOLVE: SuitePhase = {
  id: "resolve",
  title: "Resolve what is left open",
  maxCalls: 16,
  prompt:
    "Resolve every open question, and recategorize anything that is still uncategorized. Nothing should be left open, deferred or uncategorized when you are done.",
};

function cases(fixturesDir: string): Result<IngestCase[]> {
  const pdf = join(fixturesDir, "ingest", STATEMENT);
  if (!existsSync(pdf)) return { ok: false, error: `no ingest fixture at ${pdf}` };

  const facts = loadStatementFacts(pdf);
  if (!facts.ok) return facts;
  return {
    ok: true,
    value: [{ id: basename(STATEMENT, ".pdf"), pdf, facts: facts.value }],
  };
}

async function prepare(ctx: SuiteContext, kase: IngestCase): Promise<Result<SuitePhase[]>> {
  const seeded = seedFiles(ctx.workspace, [kase.pdf], SEED_DIR);
  if (!seeded.ok) return seeded;
  return { ok: true, value: [INGEST, RESOLVE] };
}

export const ingestSuite: Suite<IngestCase> = {
  id: "ingest",
  cases,
  prepare,
  systemPrompt: buildSystemPrompt,
  tools: (ctx) => createTools(ctx.runner),
  score: ({ kase, probe }) => gradeIngest(kase.id, kase.facts, probe),
};
