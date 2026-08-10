import type { Tool } from "../agent/tools.js";
import type { Result } from "../core/result.js";
import type { OpenLedgerRunner } from "../oled/command.js";
import type { LedgerProbe } from "../oled/ledger.js";
import type { RunCounters } from "../report/counters.js";
import type { RunMetrics } from "../report/recorder.js";
import type { Workspace, WorkspaceGuard } from "../sandbox/workspace.js";
import type { SuiteId } from "../shared/vocabulary.js";

/**
 * One graded claim about the ledger a run left behind. `evidence` is what a
 * report prints, so both sides are already formatted for a human.
 */
export interface AssertionResult {
  id: string;
  label: string;
  passed: boolean;
  /** The check had nothing to judge; `passed` is meaningless and the score skips it. */
  na?: true;
  evidence: { want: string; got: string };
}

export interface CaseGrade {
  caseId: string;
  assertions: AssertionResult[];
  /** Over the applicable assertions only, so an n/a check cannot inflate a score. */
  passRate: number;
  passed: boolean;
}

export function notApplicable(id: string, label: string, why: string): AssertionResult {
  return { id, label, passed: false, na: true, evidence: { want: "not applicable", got: why } };
}

export function check(id: string, label: string, passed: boolean, want: string, got: string): AssertionResult {
  return { id, label, passed, evidence: { want, got } };
}

/** `na` keeps a figure out of the pass rate; the want and got columns still carry it. */
export function reported(id: string, label: string, want: string, got: string): AssertionResult {
  return { id, label, passed: false, na: true, evidence: { want, got } };
}

export interface CheckCounts {
  passed: number;
  total: number;
}

/** The one authority on what counts as a check: an `na` assertion had nothing to judge, so it counts in neither half. */
export function countChecks(assertions: AssertionResult[]): CheckCounts {
  const applicable = assertions.filter((assertion) => !assertion.na);
  return {
    passed: applicable.filter((assertion) => assertion.passed).length,
    total: applicable.length,
  };
}

export function gradeOf(caseId: string, assertions: AssertionResult[]): CaseGrade {
  const { passed, total } = countChecks(assertions);
  return {
    caseId,
    assertions,
    passRate: total === 0 ? 0 : passed / total,
    passed: total > 0 && passed === total,
  };
}

export interface EvalCase {
  id: string;
}

/** One user turn and the call budget it gets; phases share a message history. */
export interface SuitePhase {
  id: string;
  title: string;
  prompt: string;
  maxCalls: number;
}

export interface SuiteContext {
  workspace: Workspace;
  runner: OpenLedgerRunner;
  skillText: string;
}

/** What a terminal answer tool accepts; `perCurrency` is the way to answer without fusing currencies. */
export interface SubmittedAnswer {
  answer: string;
  value?: number;
  unit?: string;
  perCurrency?: Record<string, number>;
}

/** Where the answer tool leaves its payload for the run to read once the phase ends. */
export interface AnswerSink {
  submitted: SubmittedAnswer | null;
}

export interface ScoreInput<C extends EvalCase> {
  kase: C;
  probe: LedgerProbe;
  metrics: RunMetrics;
  /** Where the run met friction. A suite that reports a journey reads it; nothing is graded on it. */
  counters: RunCounters;
  submitted: SubmittedAnswer | null;
}

/**
 * A suite in a registry of mixed case types. Every planned run pairs a suite
 * with a case its own `cases()` produced, which is what keeps the pairing true.
 */
export type AnySuite = Suite<EvalCase>;

export interface Suite<C extends EvalCase, U extends EvalCase = C> {
  id: SuiteId;
  /** Runs before any API spend, so a fixture that disagrees with itself fails cheaply. */
  cases(fixturesDir: string): Result<U[]>;
  /**
   * Whatever a case can only learn from a real ledger, answered once for the
   * whole invocation in sandboxes of the suite's own: a suite scored against
   * figures oled publishes reads them here rather than reproducing its
   * arithmetic. It runs after bootstrap and before a token is spent, and a
   * refusal refuses the invocation. Absent when the fixture already carries a
   * complete case.
   */
  resolve?(cases: U[], guard: WorkspaceGuard): Promise<Result<C[]>>;
  prepare(ctx: SuiteContext, kase: C): Promise<Result<SuitePhase[]>>;
  systemPrompt(skillText: string): string;
  tools(ctx: SuiteContext, sink: AnswerSink): Tool[];
  score(input: ScoreInput<C>): CaseGrade;
}
