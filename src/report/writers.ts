import type { Result } from "../core/result.js";
import type { SkippedModel } from "../model/capabilities.js";
import type { PlannedRun } from "../runner/matrix.js";
import type { ConfigEcho } from "./benchmark.js";
import { createFeedWriter, type FeedWriter } from "./feed.js";
import { buildLiveDoc, createLiveWriter, reopenLiveDoc, type LiveWriter } from "./live.js";
import type { RunIdentity, RunRecord } from "./record.js";
import { createReportSink, type ReportSink } from "./sink.js";

// The three surfaces a matrix leaves behind, opened together because they all
// answer to one report: the run files and benchmark, the live document a
// dashboard polls, and the feed.

/** What an existing report brings to an invocation merging into it. */
export interface PriorReport {
  /** The runs the report already holds; the benchmark is built from these and the new ones. */
  records: RunRecord[];
  /** How this invocation differs from what the report holds, or null when it does not. */
  drift: string | null;
}

export interface ReportWritersOptions {
  dir: string;
  /**
   * The report's identity rather than the invocation's: a rerun keeps the one
   * every number in the report was measured against, and its `startedAt` is what
   * makes a reopened iteration keep saying when it began.
   */
  identity: RunIdentity;
  config: ConfigEcho;
  skippedModels: SkippedModel[];
  plan: PlannedRun[];
  /** When the process now writing took the iteration up, which a rerun does not backdate. */
  openedAt: Date;
  /** Null when this invocation is the first to write the report. */
  prior: PriorReport | null;
  /** Opens the feed with the facts the console has already said. */
  header: string[];
}

export interface ReportWriters {
  sink: ReportSink;
  live: LiveWriter;
  feed: FeedWriter;
  /** Ends the live document and writes the report; the value is the leaderboard markdown. */
  close(): Result<string>;
}

export function createReportWriters(options: ReportWritersOptions): ReportWriters {
  const { dir, identity, config, plan, prior } = options;

  const sink = createReportSink(
    dir,
    identity,
    config,
    options.skippedModels,
    prior?.records ?? [],
    prior?.drift ?? null,
  );
  // A signal leaves through process.exit (see the workspace guard), which runs
  // exit handlers but resolves no promise: the benchmark of an interrupted
  // matrix is written synchronously here or not at all.
  process.on("exit", () => sink.closeOnExit());

  const doc =
    prior === null
      ? buildLiveDoc(identity, config, plan, options.openedAt)
      : reopenLiveDoc(identity, config, prior.records, plan, identity.startedAt, options.openedAt);
  const live = createLiveWriter(dir, doc);

  const feed = createFeedWriter(dir);
  feed.header(options.header);

  return {
    sink,
    live,
    feed,
    close() {
      live.finalize();
      return sink.close();
    },
  };
}
