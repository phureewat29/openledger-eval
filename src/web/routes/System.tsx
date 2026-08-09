import { sumBy } from "es-toolkit";
import { Cpu, HardDrive, HeartCrack, Trash2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { LivePayload, ProcessesPayload, SandboxesPayload } from "../../shared/payloads.js";
import { Badge, Callout, Panel, SectionHeading } from "../components/Badge.js";
import { Confirm } from "../components/Confirm.js";
import { PanelBody, TD, TH } from "../components/Table.js";
import { post } from "../lib/api.js";
import { useChannel } from "../lib/channel.js";
import { bytes, duration } from "../lib/format.js";

// What the dashboard can see of the machine it is running on: the processes a
// run is actually made of, and the sandboxes those runs leave behind. Both exist
// because a run that is killed outright cleans up neither.

function Section({
  title,
  note,
  icon,
  children,
}: {
  title: string;
  note?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section>
      <SectionHeading aside={note} icon={icon}>
        {title}
      </SectionHeading>
      <Panel className="overflow-x-auto">{children}</Panel>
    </section>
  );
}

function ProcessTree({ processes }: { processes: ProcessesPayload | null }) {
  const rows = processes?.rows ?? [];
  const note = processes?.pgid === null || processes === null ? undefined : `group ${processes.pgid}`;

  return (
    <Section title="Processes" note={note} icon={Cpu}>
      {processes?.error !== null && processes !== null && (
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

function Sandboxes({ sandboxes }: { sandboxes: SandboxesPayload | null }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const entries = sandboxes?.entries ?? [];
  const orphans = entries.filter((entry) => entry.owner === "none");
  const selected = orphans.filter((entry) => chosen.has(entry.name));
  const selectedBytes = sumBy(selected, (entry) => entry.bytes);

  const remove = async (): Promise<void> => {
    setConfirming(false);
    const names = selected.map((entry) => entry.name);
    const response = await post<{ removed: string[]; failed: { name: string; error: string }[] }>(
      "/api/sandboxes/cleanup",
      { names },
    );
    setChosen(new Set());
    if (!response.ok) return setResult(response.error);
    const { removed, failed } = response.value;
    setResult(
      failed.length === 0
        ? `Removed ${removed.length}`
        : `Removed ${removed.length}, refused ${failed.length}: ${failed[0]?.error ?? ""}`,
    );
  };

  return (
    <Section
      title="Sandboxes"
      icon={HardDrive}
      note={sandboxes === null ? undefined : `${bytes(sandboxes.reclaimableBytes)} reclaimable`}
    >
      {entries.length === 0 ? (
        <PanelBody>
          <p className="text-subtle">Nothing under the temp directory</p>
        </PanelBody>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-line px-3.5 py-2.5">
            <button
              type="button"
              onClick={() => setChosen(new Set(orphans.map((entry) => entry.name)))}
              className="text-muted hover:text-fg"
            >
              Select all orphans
            </button>
            <button type="button" onClick={() => setChosen(new Set())} className="text-muted hover:text-fg">
              None
            </button>
            <span className="flex-1" />
            {result !== null && <span className="text-subtle">{result}</span>}
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-muted transition-colors hover:border-bad hover:text-bad disabled:opacity-35 disabled:hover:border-line-strong disabled:hover:text-muted"
            >
              <Trash2 size={12} strokeWidth={1.75} aria-hidden />
              Reclaim {bytes(selectedBytes)}
            </button>
          </div>

          <table className="tnum w-full">
            <thead>
              <tr className="text-subtle">
                <th scope="col" className={TH} />
                <th scope="col" className={TH}>
                  Name
                </th>
                <th scope="col" className={`${TH} w-24 text-right`}>
                  Size
                </th>
                <th scope="col" className={`${TH} w-24 text-right`}>
                  Age
                </th>
                <th scope="col" className={`${TH} w-40`}>
                  Owner
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const orphan = entry.owner === "none";
                return (
                  <tr key={entry.path} className="border-t border-line">
                    <td className={TD}>
                      <input
                        type="checkbox"
                        className="accent-accent"
                        disabled={!orphan}
                        checked={chosen.has(entry.name)}
                        onChange={() =>
                          setChosen((set) => {
                            const next = new Set(set);
                            if (next.has(entry.name)) next.delete(entry.name);
                            else next.add(entry.name);
                            return next;
                          })
                        }
                        aria-label={`select ${entry.name}`}
                      />
                    </td>
                    <td className={TD} title={entry.path}>
                      {entry.name}
                    </td>
                    <td className={`${TD} text-right text-muted`}>{bytes(entry.bytes)}</td>
                    <td className={`${TD} text-right text-muted`}>{duration(entry.ageMs)}</td>
                    <td className={TD}>
                      <Badge tone={orphan ? "warn" : "accent"} dot={!orphan}>
                        {orphan ? "Orphaned" : `In use · ${entry.owner}`}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {confirming && (
        <Confirm
          title={`Remove ${selected.length} sandboxes?`}
          action="Remove"
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        >
          <p>
            This deletes {bytes(selectedBytes)} from the temp directory and cannot be undone. Only sandboxes
            nothing is using are ever removed — the server checks again before deleting anything.
          </p>
        </Confirm>
      )}
    </Section>
  );
}

/**
 * A run that was killed outright leaves live.json saying "running" for ever, and
 * that frozen document is enough to refuse every later launch. This is the way
 * out — offered only once the run is provably gone.
 */
function Crashed({ live }: { live: LivePayload | null }) {
  const [note, setNote] = useState<string | null>(null);
  if (live === null || live.kind !== "running-stale" || live.slug === null) return null;

  const finish = async (): Promise<void> => {
    const result = await post(`/api/iterations/${live.slug ?? ""}/finish`, {});
    setNote(result.ok ? "marked finished" : result.error);
  };

  return (
    <Section title="Crashed Run" icon={HeartCrack}>
      <Callout tone="warn">
        <Badge tone="warn">crashed</Badge>{" "}
        <span className="text-muted">
          {live.slug} still says it is running, but its heartbeat stopped. Until it is finalised it blocks
          every new launch.
        </span>
      </Callout>
          {note !== null && <p className="my-2 text-subtle">{note}</p>}
      <button
        type="button"
        onClick={() => void finish()}
        className="rounded-md border border-line-strong px-2.5 py-1 text-muted transition-colors hover:border-accent hover:text-accent"
      >
        Mark Finished
      </button>
    </Section>
  );
}

export function System() {
  const processes = useChannel<ProcessesPayload>("processes");
  const sandboxes = useChannel<SandboxesPayload>("sandboxes");
  const live = useChannel<LivePayload>("live");

  return (
    <div className="space-y-8 p-5">
      <Crashed live={live} />
      <ProcessTree processes={processes} />
      <Sandboxes sandboxes={sandboxes} />
    </div>
  );
}
