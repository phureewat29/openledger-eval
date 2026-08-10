import { createSubmitAnswerTool, createTools } from "../../agent/tools.js";
import type { Result } from "../../core/result.js";
import { buildSystemPrompt } from "../adapter.js";
import type { Suite, SuiteContext, SuitePhase } from "../types.js";
import { deriveQueryGoldens } from "./derive.js";
import { loadQueryQuestions, type QueryCase, type QueryQuestion } from "./goldens.js";
import { gradeQuery } from "./score.js";
import { seedLedger } from "./seed.js";

/** Enough calls to read the ledger a few ways and still answer; a case that needs more is a finding. */
const MAX_CALLS = 16;

export const SUBMIT_PARAGRAPH = `## Answering

When you have the answer, finish by calling \`submit_answer\` exactly once: the numeric result goes in \`value\` (\`per_currency\` for multi-currency answers), the unit in \`unit\`, and the answer itself in \`answer\` — when the question asks for a name or a word, that name alone with no sentence around it, otherwise a one-line summary. Each question says which of these it wants. A prose reply does not end the task.`;

function systemPrompt(skillText: string): string {
  return `${buildSystemPrompt(skillText)}\n\n${SUBMIT_PARAGRAPH}\n`;
}

async function prepare(ctx: SuiteContext, kase: QueryCase): Promise<Result<SuitePhase[]>> {
  const seeded = await seedLedger(ctx.runner, kase.rows);
  if (!seeded.ok) return seeded;
  return {
    ok: true,
    // The question itself is the heading: a case has no title to summarise it,
    // because a summary of a question is a second thing to keep true.
    value: [{ id: "answer", title: kase.prompt, maxCalls: MAX_CALLS, prompt: kase.prompt }],
  };
}

export const querySuite: Suite<QueryCase, QueryQuestion> = {
  id: "query",
  cases: loadQueryQuestions,
  resolve: deriveQueryGoldens,
  prepare,
  systemPrompt,
  tools: (ctx, sink) => [...createTools(ctx.runner), createSubmitAnswerTool(sink)],
  score: ({ kase, submitted }) => gradeQuery(kase, submitted),
};
