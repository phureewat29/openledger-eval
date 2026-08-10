import { range, zip } from "es-toolkit";
import { tryExecute } from "../core/result.js";
import type { ValidatedModel } from "../model/capabilities.js";
import { buildCounters } from "../report/counters.js";
import type { RunRecord } from "../report/record.js";
import { createRecorder } from "../report/recorder.js";
import type { SuiteId } from "../shared/vocabulary.js";
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
 * A finished run leaves through `onProgress` and nowhere else, so whoever keeps
 * the records keeps the same set whether the matrix ran out or was interrupted.
 */
export async function runMatrix(plan: PlannedRun[], deps: MatrixDeps, concurrency: number): Promise<void> {
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < plan.length; index = next++) {
      const planned = plan[index];
      if (!planned) return;
      deps.onStart(planned);
      deps.onProgress(await settle(deps, planned));
    }
  };

  const size = Math.max(1, Math.min(concurrency, plan.length));
  await Promise.all(range(size).map(() => worker()));
}
