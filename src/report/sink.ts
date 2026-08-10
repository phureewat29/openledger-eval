import type { Result } from "../core/result.js";
import type { SkippedModel } from "../model/capabilities.js";
import { buildBenchmark, type ConfigEcho } from "./benchmark.js";
import { renderLeaderboard } from "./leaderboard.js";
import { mergeRecords } from "./merge.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { warnOnce } from "./warn.js";
import { writeBenchmark, writeLeaderboard, writeRunFiles } from "./write.js";

// Where finished runs drain to. A run's files are written the moment it is
// graded, and the benchmark is built from whatever has drained in, so a matrix
// stopped halfway still leaves a report of the runs that were paid for.

export interface ReportSink {
  /** Files one finished run and keeps it for the benchmark. */
  add(record: RunRecord): void;
  /** Everything added so far, in completion order. */
  records(): RunRecord[];
  /** Writes benchmark.json and leaderboard.md, and returns the leaderboard markdown. */
  close(): Result<string>;
  /**
   * The interrupt path: writes the report unless close() already did, so the
   * clean path writes one benchmark and not two. Called from an `exit` handler,
   * where no promise resolves and every write it reaches must be synchronous.
   */
  closeOnExit(): void;
}

/**
 * A run-file failure warns once and the matrix carries on, as the live and feed
 * writers do: one unwritable file is no reason to abandon a paid matrix, and
 * the run is still counted.
 *
 * `prior` is what the report already held when this invocation was a rerun
 * merging into it. It is empty for an ordinary matrix, which is why the
 * benchmark of a fresh run is built from exactly the runs that produced it.
 */
export function createReportSink(
  dir: string,
  identity: RunIdentity,
  config: ConfigEcho,
  skippedModels: SkippedModel[],
  prior: RunRecord[] = [],
  /** Set when this invocation is merging into a report measured against something else. */
  buildDrift: string | null = null,
): ReportSink {
  const finished: RunRecord[] = [];
  const warn = warnOnce();
  let closed = false;

  function add(record: RunRecord): void {
    finished.push(record);
    const written = writeRunFiles(dir, record, config.trials);
    if (!written.ok) warn(`${written.error}; the run still counts, and later run files fail silently`);
  }

  function close(): Result<string> {
    // Set before the writes, not after: a failed close is reported once by
    // whoever asked for it, and never retried from the exit handler.
    closed = true;

    const benchmark = buildBenchmark(mergeRecords(prior, finished), identity, config, skippedModels, buildDrift);
    const savedBenchmark = writeBenchmark(dir, benchmark);
    if (!savedBenchmark.ok) return savedBenchmark;

    const leaderboard = renderLeaderboard(benchmark);
    const savedLeaderboard = writeLeaderboard(dir, leaderboard);
    if (!savedLeaderboard.ok) return savedLeaderboard;

    return { ok: true, value: leaderboard };
  }

  function closeOnExit(): void {
    if (closed) return;
    const written = close();
    if (written.ok) return;
    process.stderr.write(`${written.error}\n`);
  }

  return {
    add,
    records: () => [...finished],
    close,
    closeOnExit,
  };
}
