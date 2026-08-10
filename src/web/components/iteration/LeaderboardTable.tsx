import type { BenchmarkEntry } from "../../../report/benchmark.js";
import { passRateCell, rankCell } from "../../../report/leaderboard.js";
import { duration, tokens, usd } from "../../../shared/format.js";
import { shortModel } from "../../lib/format.js";
import { TableBox, TD, TH } from "../Table.js";

// One suite's ranked rows, exactly as buildBenchmark ordered them — this table
// never re-sorts, so the medal on row one always matches the entry the caller
// put there. rankCell and passRateCell come from report/leaderboard.ts, and
// duration/tokens/usd from shared/format.ts — both read by the committed
// markdown too, so the two can never format the same number two different ways.

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
