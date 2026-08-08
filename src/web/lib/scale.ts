import { useEffect, useState } from "react";
import { get } from "./api.js";

// What a run of a given size costs, taken from the last one that actually ran.
// Every control that spends money prices itself from here, so a launch and a
// rerun quote the same rate and cannot drift into disagreeing about it.

export interface CaseCounts {
  [suite: string]: number;
}

export interface Scale {
  cases: CaseCounts;
  /** null until a benchmark with prices has been read; a quote is skipped rather than guessed. */
  costPerRun: number | null;
}

const NO_SCALE: Scale = { cases: {}, costPerRun: null };

/**
 * Case counts come from the newest benchmark rather than from the suites
 * themselves: the dashboard never loads a suite, and a figure derived from the
 * last real run is honest in a way a hardcoded one would stop being.
 */
export function useScale(): Scale {
  const [scale, setScale] = useState<Scale>(NO_SCALE);

  useEffect(() => {
    void (async () => {
      const list = await get<{ iterations: { slug: string; hasBenchmark: boolean }[] }>("/api/iterations");
      if (!list.ok) return;
      const newest = list.value.iterations.find((iteration) => iteration.hasBenchmark);
      if (newest === undefined) return;

      const detail = await get<{
        benchmark: { entries: { suite: string; cases: { total: number }; totalCostUsd: number | null }[] } | null;
      }>(`/api/iterations/${newest.slug}`);
      if (!detail.ok || detail.value.benchmark === null) return;

      const cases: CaseCounts = {};
      let cost = 0;
      let runs = 0;
      for (const entry of detail.value.benchmark.entries) {
        cases[entry.suite] = Math.max(cases[entry.suite] ?? 0, entry.cases.total);
        if (entry.totalCostUsd !== null) {
          cost += entry.totalCostUsd;
          runs += entry.cases.total;
        }
      }
      setScale({ cases, costPerRun: runs > 0 ? cost / runs : null });
    })();
  }, []);

  return scale;
}

/** What that many runs last cost, as a phrase, or nothing at all when no benchmark can price it. */
export function estimate(scale: Scale, runs: number): string {
  if (scale.costPerRun === null || runs === 0) return "";
  return ` · ~$${(scale.costPerRun * runs).toFixed(2)} at the last run's rate`;
}
