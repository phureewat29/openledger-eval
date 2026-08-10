import { sumBy } from "es-toolkit";
import { HardDrive, Trash2 } from "lucide-react";
import { useState } from "react";
import { duration } from "../../../shared/format.js";
import type { SandboxesPayload } from "../../../shared/payloads.js";
import { post } from "../../lib/api.js";
import { toggle } from "../../lib/collections.js";
import { bytes } from "../../lib/format.js";
import { Badge } from "../Badge.js";
import { Confirm } from "../Confirm.js";
import { PanelBody, TD, TH } from "../Table.js";
import { Section } from "./Section.js";

// What a run leaves behind under the temp directory even when it is killed
// outright, and the one control that reclaims it.

export function Sandboxes({ sandboxes }: { sandboxes: SandboxesPayload | null }) {
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
                        onChange={() => setChosen((set) => toggle(set, entry.name))}
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
