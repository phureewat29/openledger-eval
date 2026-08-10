import { Cpu } from "lucide-react";
import { duration } from "../../../shared/format.js";
import type { ProcessesPayload } from "../../../shared/payloads.js";
import { bytes } from "../../lib/format.js";
import { PanelBody, TD, TH } from "../Table.js";
import { Section } from "./Section.js";

// The processes a run is actually made of, so a pause that claims it froze the
// whole tree can be checked against what the OS itself reports.

export function ProcessTree({ processes }: { processes: ProcessesPayload | null }) {
  const rows = processes?.rows ?? [];
  const note = processes === null || processes.pgid === null ? undefined : `group ${processes.pgid}`;

  return (
    <Section title="Processes" note={note} icon={Cpu}>
      {processes !== null && processes.error !== null && (
        <PanelBody>
          <p className="text-bad">{processes.error}</p>
        </PanelBody>
      )}
      {rows.length === 0 ? (
        <PanelBody>
          <p className="text-subtle">No run in flight</p>
        </PanelBody>
      ) : (
        <table className="tnum w-full">
          <thead>
            <tr className="text-subtle">
              <th scope="col" className={`${TH} w-20`}>
                PID
              </th>
              <th scope="col" className={`${TH} w-16`}>
                State
              </th>
              <th scope="col" className={`${TH} w-16 text-right`}>
                CPU
              </th>
              <th scope="col" className={`${TH} w-20 text-right`}>
                RSS
              </th>
              <th scope="col" className={`${TH} w-20 text-right`}>
                Elapsed
              </th>
              <th scope="col" className={TH}>
                Command
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pid} className="border-t border-line">
                <td className={`${TD} text-muted`}>
                  {/* The indent is the span's, not the cell's: setting the cell's
                      own padding-left inline overrode the padding every other
                      cell has, and put a root process hard against the edge. */}
                  <span className="inline-block" style={{ marginLeft: `${row.depth * 0.85}rem` }}>
                    {row.pid}
                  </span>
                </td>
                {/* ps's own letters, amber for the one that means frozen: this
                    table is where a reader checks that a pause really reached
                    the whole tree rather than only the process it was aimed at. */}
                <td className={`${TD} ${row.state.startsWith("T") ? "text-warn" : "text-subtle"}`}>
                  {row.state}
                </td>
                {/* Only a process actually working is worth colouring. */}
                <td className={`${TD} text-right ${row.cpu >= 10 ? "text-accent" : "text-muted"}`}>
                  {row.cpu.toFixed(1)}%
                </td>
                <td className={`${TD} text-right text-muted`}>{bytes(row.rssBytes)}</td>
                <td className={`${TD} text-right text-muted`}>{duration(row.elapsedSec * 1_000)}</td>
                <td className={`${TD} max-w-0 truncate`} title={row.command}>
                  {row.command}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
