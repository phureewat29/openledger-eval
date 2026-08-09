import { useEffect, useState } from "react";
import { Navigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import type { Benchmark, BenchmarkEntry } from "../../report/benchmark.js";
import type { FeedLine } from "../../report/feed.js";
import { liveItemOf, type LiveItem } from "../../report/live-item.js";
import type { IterationSummary, LoadedRun } from "../../server/reports-fs.js";
import type { LivePayload } from "../../shared/payloads.js";
import { Empty } from "../components/Empty.js";
import { FailureSummary } from "../components/iteration/FailureSummary.js";
import { IdentityTable } from "../components/iteration/IdentityTable.js";
import { LeaderboardTable } from "../components/iteration/LeaderboardTable.js";
import { Legend } from "../components/grid/Legend.js";
import { SuiteGrid } from "../components/grid/SuiteGrid.js";
import { RerunDialog, type RerunScope } from "../components/RerunDialog.js";
import { RunSheet } from "../components/run/RunSheet.js";
import { modelSlug } from "../../shared/vocabulary.js";
import { get } from "../lib/api.js";
import { liveIsShowing } from "../lib/live-route.js";

interface IterationResponse {
  summary: IterationSummary;
  benchmark: Benchmark | null;
  runs: LoadedRun[];
  feed: FeedLine[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "loaded"; data: IterationResponse };

/** Suite order follows first appearance in entries, which buildBenchmark already ranked by config.suites. */
function suitesOf(entries: BenchmarkEntry[]): BenchmarkEntry["suite"][] {
  return [...new Set(entries.map((entry) => entry.suite))];
}

/**
 * A finished run's records, in the shape the live grid draws — through the same
 * projection the runner uses while a matrix is in flight, so the two grids
 * cannot come to disagree about what a cell means.
 */
function itemsOf(runs: LoadedRun[]): LiveItem[] {
  return runs.flatMap((run) => (run.record === null ? [] : [liveItemOf(run.record)]));
}

export function Iteration() {
  const { slug } = useParams<{ slug: string }>();
  const live = useOutletContext<LivePayload | null>();
  const [, setParams] = useSearchParams();

  // The same handoff the live screen uses: name the cell in the URL and let the
  // sheet pick it up, so a run is shareable from either matrix.
  const onOpen = (item: LiveItem): void => {
    setParams((held) => {
      const next = new URLSearchParams(held);
      next.set("model", modelSlug(item.model));
      next.set("suite", item.suite);
      next.set("case", item.caseId);
      return next;
    });
  };
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [rerunning, setRerunning] = useState<RerunScope | null>(null);

  useEffect(() => {
    if (slug === undefined) return;
    setState({ kind: "loading" });
    void get<IterationResponse>(`/api/iterations/${slug}`).then((result) => {
      setState(result.ok ? { kind: "loaded", data: result.value } : { kind: "error", error: result.error });
    });
  }, [slug]);

  if (slug === undefined) return <Empty title="no iteration named" />;
  // Ahead of the read, not after it, so the handover never flashes a page it is
  // about to leave. Replaced rather than pushed: pushed, Back would return here
  // and bounce the reader straight out again.
  if (liveIsShowing(live, slug)) return <Navigate to="/" replace />;
  if (state.kind === "loading") return <Empty title={`reading ${slug}`} />;
  if (state.kind === "error") return <Empty title="couldn't load this iteration" hint={state.error} />;

  const { benchmark, runs } = state.data;
  const cells = itemsOf(runs);
  const suites = [...new Set(cells.map((item) => item.suite))];

  return (
    <div className="space-y-8 p-5">
      <h1 className="tnum text-fg">{slug}</h1>

      {benchmark === null ? (
        <Empty
          title="never scored"
          hint="this run ended before it could write a benchmark, so there is nothing to rank"
        />
      ) : (
        <>
          <section>
            <IdentityTable identity={benchmark.identity} config={benchmark.config} />
          </section>

          {suitesOf(benchmark.entries).map((suite) => (
            <section key={suite} className="space-y-4">
              <div>
                <h2 className="mb-2 uppercase tracking-wider text-accent">{suite}</h2>
                <LeaderboardTable entries={benchmark.entries.filter((entry) => entry.suite === suite)} />
              </div>
              {suites.includes(suite) && (
                <SuiteGrid
                  suite={suite}
                  items={cells.filter((item) => item.suite === suite)}
                  onOpen={onOpen}
                  onRerun={(model, cases) => setRerunning({ slug, model, suite, cases })}
                />
              )}
            </section>
          ))}

          <FailureSummary runs={runs} />

          {benchmark.skippedModels.length > 0 && (
            <section>
              <h2 className="mb-2 text-muted">skipped models</h2>
              <ul className="tnum space-y-0.5">
                {benchmark.skippedModels.map((model) => (
                  <li key={model.id}>
                    {model.id} <span className="text-subtle">— {model.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <Legend />

      <RunSheet onRerun={setRerunning} />
      <RerunDialog scope={rerunning} onClose={() => setRerunning(null)} />
    </div>
  );
}
