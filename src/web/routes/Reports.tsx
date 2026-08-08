import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { IterationDigest, IterationStatus } from "../../server/digest.js";
import { Badge, type Tone } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { TableBox, TD, TH } from "../components/Table.js";
import { get } from "../lib/api.js";
import { duration, shortModel, usd } from "../lib/format.js";

// Every iteration on disk, with enough of each to choose between them. A list of
// slugs is a list of navigation targets; what a reader wants to know first is how
// big the run was, how it went and what it cost.

const STATUS_TONE: Record<IterationStatus, Tone> = {
  running: "accent",
  crashed: "bad",
  done: "muted",
  unknown: "muted",
};

const STATUS_WORD: Record<IterationStatus, string> = {
  running: "Running",
  crashed: "Crashed",
  done: "Done",
  unknown: "Unknown",
};

/** The slug is a local timestamp already; this is the same instant said in words. */
function when(startedAt: string | null): string {
  if (startedAt === null) return "—";
  return new Date(startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function percent(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(0)}%`;
}

/**
 * Where a row opens. A run still going has nothing to read on its own page —
 * the Live screen is where its grid moves — so the row goes there directly
 * rather than through a page that would only hand the reader on.
 *
 * `running` already implies unscored: `statusOf` in the digest calls an
 * iteration done the moment a benchmark exists beside it, however its live.json
 * reads. So a rerun into a scored report keeps pointing at that report, which is
 * where its numbers are.
 */
function openAt(iteration: IterationDigest): string {
  return iteration.status === "running" ? "/" : `/reports/${iteration.slug}`;
}

/** A rate reads as trouble on the same thresholds a grid cell does. */
function rateTone(rate: number | null): string {
  if (rate === null) return "text-subtle";
  if (rate >= 1) return "text-accent";
  return rate === 0 ? "text-bad" : "text-warn";
}

export function Reports() {
  const [iterations, setIterations] = useState<IterationDigest[] | null>(null);

  useEffect(() => {
    void get<{ iterations: IterationDigest[] }>("/api/iterations").then((result) => {
      setIterations(result.ok ? result.value.iterations : []);
    });
  }, []);

  if (iterations === null) return <Empty title="Reading reports/" />;
  if (iterations.length === 0) {
    return <Empty title="No iterations yet" hint="reports/ is empty — launch a run to fill it" />;
  }

  return (
    <div className="p-5">
      <TableBox>
        <table className="tnum w-full">
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Iteration
              </th>
              <th scope="col" className={TH}>
                Started
              </th>
              <th scope="col" className={TH}>
                Status
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Runs
              </th>
              <th scope="col" className={TH}>
                Suites
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Models
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Pass rate
              </th>
              <th scope="col" className={TH}>
                Best
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Time
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Cost
              </th>
              <th scope="col" className={TH} />
            </tr>
          </thead>
          <tbody>
            {iterations.map((iteration) => (
              <tr key={iteration.slug} className="group border-t border-line hover:bg-surface-2">
                <td className={TD}>
                  <Link to={openAt(iteration)} className="text-fg hover:text-accent">
                    {iteration.slug}
                  </Link>
                </td>
                <td className={`${TD} text-muted`}>{when(iteration.startedAt)}</td>
                <td className={TD}>
                  <Badge
                    tone={STATUS_TONE[iteration.status]}
                    dot={iteration.status === "running"}
                    pulse={iteration.status === "running"}
                  >
                    {STATUS_WORD[iteration.status]}
                  </Badge>
                </td>
                <td className={`${TD} text-right text-muted`}>
                  {/* While a run is going this is its progress, not its size. */}
                  {iteration.finished < iteration.runs
                    ? `${iteration.finished}/${iteration.runs}`
                    : iteration.runs}
                </td>
                <td className={`${TD} uppercase tracking-wide text-accent`}>
                  {iteration.suites.join(" ") || "—"}
                </td>
                <td className={`${TD} text-right text-muted`}>{iteration.models}</td>
                <td className={`${TD} text-right ${rateTone(iteration.meanPassRate)}`}>
                  {percent(iteration.meanPassRate)}
                </td>
                <td className={`${TD} text-muted`} title={iteration.best?.model}>
                  {iteration.best === null
                    ? "—"
                    : `${shortModel(iteration.best.model)} ${percent(iteration.best.passRate)}`}
                </td>
                <td className={`${TD} text-right text-muted`}>
                  {iteration.durationMs === null ? "—" : duration(iteration.durationMs)}
                </td>
                <td className={`${TD} text-right text-muted`}>{usd(iteration.costUsd)}</td>
                <td className={TD}>
                  <Link
                    to={openAt(iteration)}
                    aria-label={`Open ${iteration.slug}`}
                    className="block text-subtle transition-colors hover:text-accent group-hover:text-muted"
                  >
                    <ChevronRight size={14} strokeWidth={2} aria-hidden />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableBox>
    </div>
  );
}
