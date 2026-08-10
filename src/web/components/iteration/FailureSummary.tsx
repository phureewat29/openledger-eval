import { groupBy } from "es-toolkit";
import { topFailures } from "../../../report/failures.js";
import type { LoadedRun } from "../../../server/reports-fs.js";
import { plural, shortModel } from "../../lib/format.js";

// Why a model's cases failed, not just how many did — grouped per model so a
// reader chasing one model's row in the leaderboard can jump straight to what
// it kept missing.

const PER_MODEL_LIMIT = 4;

interface ModelFailures {
  model: string;
  failures: ReturnType<typeof topFailures>;
}

/** `record.model` is the real id; `run.model` on LoadedRun is only the directory slug. */
function byModel(runs: LoadedRun[]): ModelFailures[] {
  const records = runs.flatMap((run) => (run.record === null ? [] : [run.record]));
  const grouped = groupBy(records, (record) => record.model);
  return Object.entries(grouped)
    .map(([model, group]) => ({ model, failures: topFailures(group, PER_MODEL_LIMIT) }))
    .filter((entry) => entry.failures.length > 0)
    .toSorted((a, b) => a.model.localeCompare(b.model));
}

export function FailureSummary({ runs }: { runs: LoadedRun[] }) {
  const groups = byModel(runs);
  if (groups.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-muted">checks that failed most, per model</h2>
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.model}>
            <h3 className="tnum mb-1 text-fg" title={group.model}>
              {shortModel(group.model)}
            </h3>
            <table className="tnum w-full">
              <tbody>
                {group.failures.map((failure) => (
                  <tr key={failure.id} className="border-t border-line">
                    <td className="py-0.5 pr-4">{failure.label}</td>
                    <td className="py-0.5 text-bad">failed in {plural(failure.runs, "run")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
}
