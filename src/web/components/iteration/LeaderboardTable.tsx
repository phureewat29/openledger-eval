import type { BenchmarkEntry } from "../../../report/benchmark.js";
import { duration, shortModel, tokens, usd } from "../../lib/format.js";
import { TableBox, TD, TH } from "../Table.js";

// One suite's ranked rows, exactly as buildBenchmark ordered them — this table
// never re-sorts, so the medal on row one always matches the entry the caller
// put there.

const MEDALS = ["🥇", "🥈", "🥉"];

function rankCell(position: number): string {
  const medal = MEDALS[position - 1];
  return medal === undefined ? String(position) : `${position} ${medal}`;
}

/** Fractions in, a percentage out — the benchmark never carries a pre-formatted rate. */
function passRateCell(entry: BenchmarkEntry): string {
  const pct = `${(entry.meanPassRate * 100).toFixed(1)}%`;
  return entry.stddevPassRate === null ? pct : `${pct} ±${(entry.stddevPassRate * 100).toFixed(1)}`;
}

const HEAD = `${TH} text-right`;

export function LeaderboardTable({ entries }: { entries: BenchmarkEntry[] }) {
  return (
    <TableBox>
      <table className="tnum w-full">
      <thead>
        <tr className="text-subtle">
          <th scope="col" className={TH}>
            #
          </th>
          <th scope="col" className={TH}>
            Model
          </th>
          <th scope="col" className={HEAD}>
            Cases
          </th>
          <th scope="col" className={HEAD}>
            Pass rate
          </th>
          <th scope="col" className={HEAD}>
            Avg time
          </th>
          <th scope="col" className={HEAD}>
            Avg tokens
          </th>
          <th scope="col" className={HEAD}>
            Cost
          </th>
          <th scope="col" className={`${TH} text-right`}>
            Tool calls
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => (
          <tr key={entry.model} className="border-t border-line">
            <td className={TD}>{rankCell(index + 1)}</td>
            <td className={TD} title={entry.model}>
              {shortModel(entry.model)}
            </td>
            <td className={`${TD} text-right`}>
              {entry.cases.passed}/{entry.cases.total}
            </td>
            <td className={`${TD} text-right`}>{passRateCell(entry)}</td>
            <td className={`${TD} text-right`}>{duration(entry.avgDurationMs)}</td>
            <td className={`${TD} text-right`}>
              {tokens(entry.avgTokens.in)} / {tokens(entry.avgTokens.out)}
            </td>
            <td className={`${TD} text-right`}>{usd(entry.totalCostUsd)}</td>
            <td className={`${TD} text-right`}>{entry.avgToolCalls.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
      </table>
    </TableBox>
  );
}
