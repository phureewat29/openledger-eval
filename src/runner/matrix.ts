import chalk from "chalk";
import { range, zip } from "es-toolkit";
import type { SuiteId } from "../config.js";
import { tryExecute } from "../core/result.js";
import type { ValidatedModel } from "../model/capabilities.js";
import { buildCounters } from "../report/counters.js";
import type { RunRecord, TerminalState } from "../report/record.js";
import { createRecorder } from "../report/recorder.js";
import type { AnySuite, EvalCase } from "../suites/types.js";

/** One cell of the matrix: a model, a case of one suite, and which trial of it this is. */
export interface PlannedRun {
  model: ValidatedModel;
  suite: AnySuite;
  kase: EvalCase;
  /** 1-based. */
  trial: number;
}

/** Round-robins full per-model plans into one list, so adjacent cells belong to different models. */
function interleave<T>(lists: T[][]): T[] {
  return zip(...lists).flatMap((row) => row.filter((item): item is T => item !== undefined));
}

/**
 * Same cross product as looping model, then suite, then case, then trial —
 * but interleaved round-robin across models, so a matrix run exercises
 * several models at once instead of draining one before starting the next.
 */
export function expandPlan(
  models: ValidatedModel[],
  suites: AnySuite[],
  casesBySuite: ReadonlyMap<SuiteId, EvalCase[]>,
  trials: number,
): PlannedRun[] {
  const perModel = models.map((model) =>
    suites.flatMap((suite) =>
      (casesBySuite.get(suite.id) ?? []).flatMap((kase) =>
        range(1, trials + 1).map((trial) => ({ model, suite, kase, trial })),
      ),
    ),
  );
  return interleave(perModel);
}

export interface MatrixDeps {
  runOne: (planned: PlannedRun) => Promise<RunRecord>;
  /** Called once a cell is claimed, before its run has started. */
  onStart: (planned: PlannedRun) => void;
  /** Called as each run finishes, in completion order. */
  onProgress: (record: RunRecord) => void;
}

/** A run that threw is a harness bug, and one bug must not take the rest of the matrix with it. */
function crashedRecord(planned: PlannedRun, error: string): RunRecord {
  const empty = createRecorder().snapshot();
  return {
    model: planned.model.id,
    suite: planned.suite.id,
    caseId: planned.kase.id,
    trial: planned.trial,
    state: "sandbox_error",
    error,
    grade: null,
    metrics: empty.metrics,
    counters: buildCounters(empty.events),
    questionsRaised: 0,
    costUsd: null,
    events: empty.events,
  };
}

async function settle(deps: MatrixDeps, planned: PlannedRun): Promise<RunRecord> {
  const attempt = await tryExecute(() => deps.runOne(planned));
  if (attempt.ok) return attempt.value;
  return crashedRecord(planned, attempt.error);
}

/**
 * Records come back in plan order however the runs interleave, so a report of
 * the same matrix reads the same twice.
 */
export async function runMatrix(
  plan: PlannedRun[],
  deps: MatrixDeps,
  concurrency: number,
): Promise<RunRecord[]> {
  const records: RunRecord[] = new Array(plan.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < plan.length; index = next++) {
      const planned = plan[index];
      if (!planned) return;
      deps.onStart(planned);
      const record = await settle(deps, planned);
      records[index] = record;
      deps.onProgress(record);
    }
  };

  const size = Math.max(1, Math.min(concurrency, plan.length));
  await Promise.all(range(size).map(() => worker()));
  return records;
}

const STATE_COLOR: Record<TerminalState, (text: string) => string> = {
  graded: chalk.green,
  endpoint_error: chalk.yellow,
  sandbox_error: chalk.red,
};

/** Written as each run finishes: a matrix of long runs has to show it is moving. */
export function printRunLine(record: RunRecord): void {
  const grade = record.grade ? `${Math.round(record.grade.passRate * 100)}%` : "—";
  const trial = record.trial > 1 ? ` t${record.trial}` : "";
  process.stdout.write(
    `${chalk.bold(record.model)} · ${record.suite} · ${record.caseId}${trial} · ` +
      `${STATE_COLOR[record.state](record.state)} · ${grade} · ` +
      `${(record.metrics.durationMs / 1_000).toFixed(1)}s\n`,
  );
}
