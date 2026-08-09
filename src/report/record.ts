import type { SuiteId } from "../config.js";
import type { ModelPricing } from "../model/capabilities.js";
import type { CaseGrade } from "../suites/types.js";
import type { RunCounters } from "./counters.js";
import type { RunEvent } from "./events.js";
import type { RunMetrics } from "./recorder.js";

/** What every run of one invocation was measured against, pinned so a number can be reproduced. */
export interface RunIdentity {
  startedAt: string;
  oledVersion: string;
  skillVersion: string;
  skillSha256: string;
  /** The questions and the answer contract, so a reworded prompt is visible as a different build. */
  suiteSha256: string;
  evalVersion: string;
}

/**
 * How a planned run ended. Only `graded` carries a grade; the other two say the
 * harness or the endpoint failed, never that the model did.
 */
export type TerminalState = "graded" | "endpoint_error" | "sandbox_error";

/** Everything one run left behind, events included, so a report can be rebuilt from it alone. */
export interface RunRecord {
  model: string;
  suite: SuiteId;
  caseId: string;
  /** 1-based. */
  trial: number;
  state: TerminalState;
  error: string | null;
  grade: CaseGrade | null;
  metrics: RunMetrics;
  counters: RunCounters;
  questionsRaised: number;
  costUsd: number | null;
  events: RunEvent[];
}

/**
 * A run without its transcript. The events are the bulk of a record — a single
 * one reaches 130KB — and a whole iteration's worth is read, parsed and sent
 * only for a grid that reads the grade and the duration. Anything listing many
 * runs speaks this; only the sheet for one open run asks for the events.
 */
export type RunSummary = Omit<RunRecord, "events">;

export function summarise(record: RunRecord): RunSummary {
  const { events: _events, ...summary } = record;
  return summary;
}

/**
 * The name a run's files are written under, minus the extension. `-t<n>` only
 * once more than one trial ran, so a single-trial file keeps the case's own
 * name. The one authority on it: a dashboard link to a run has to name the same
 * file the writer produced.
 */
export function runFileStem(caseId: string, trial: number, trials: number): string {
  return trials > 1 ? `${caseId}-t${trial}` : caseId;
}

/** null rather than a number when the tokens were estimated: a guess priced as a fact reads as one. */
export function computeCostUsd(metrics: RunMetrics, pricing: ModelPricing | null): number | null {
  if (pricing === null || metrics.tokensEstimated) return null;
  return (
    metrics.tokensIn * pricing.promptUsdPerTok + metrics.tokensOut * pricing.completionUsdPerTok
  );
}
