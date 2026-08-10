import { sumBy } from "es-toolkit";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SuiteId } from "../../shared/vocabulary.js";
import { get, post } from "../lib/api.js";
import { toggle } from "../lib/collections.js";
import { plural, shortModel } from "../lib/format.js";
import { estimate, useScale } from "../lib/scale.js";
import { Overlay } from "./Overlay.js";

// The one control that spends money. Everything here exists to make the size of
// that spend visible before the button is pressed rather than after: the count
// of runs it will start, and — when a past benchmark can pay for the estimate —
// roughly what the last one of that size cost.

interface Bootstrap {
  suites: SuiteId[];
  models: string[];
}

function launchLabel(sending: boolean, runs: number): string {
  if (sending) return "Launching…";
  if (runs === 0) return "Launch";
  return `Launch ${runs} runs`;
}

export function LaunchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [suites, setSuites] = useState<Set<string>>(new Set());
  const [models, setModels] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scale = useScale();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setError(null);
    void get<Bootstrap>("/api/bootstrap").then((result) => {
      if (!result.ok) return setError(result.error);
      setBoot(result.value);
      // Every suite, because running the whole thing is the ordinary case and a
      // suite costs nothing on its own. Models stay unticked: they are what
      // multiplies the bill, so choosing them is always deliberate.
      setSuites(new Set(result.value.suites));
    });
  }, [open]);

  if (!open) return null;

  const runs = sumBy([...suites], (suite) => scale.cases[suite] ?? 0) * models.size;
  const ready = suites.size > 0 && models.size > 0 && !sending;

  const launch = async (): Promise<void> => {
    setSending(true);
    setError(null);
    const result = await post("/api/launch", { suites: [...suites], models: [...models] });
    setSending(false);
    if (!result.ok) return setError(result.error);

    // Straight to the live screen: the only reason to start a run is to watch
    // it, and whatever was being read a moment ago is not that.
    onClose();
    navigate("/");
  };

  return (
    <Overlay onClose={onClose} label="New Run" className="flex max-h-[85vh] w-[min(34rem,92vw)] flex-col">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-fg">New Run</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <p className="mb-1.5 text-subtle">Suites</p>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(boot?.suites ?? []).map((suite) => (
            <button
              key={suite}
              type="button"
              onClick={() => setSuites((set) => toggle(set, suite))}
              className={[
                "rounded-md border px-2.5 py-1 transition-colors",
                suites.has(suite)
                  ? "border-accent text-accent"
                  : "border-line text-muted hover:border-line-strong",
              ].join(" ")}
            >
              {suite}
              {scale.cases[suite] !== undefined && (
                <span className="tnum ml-1.5 text-subtle">{scale.cases[suite]}</span>
              )}
            </button>
          ))}
        </div>

        <p className="mb-1.5 flex items-center gap-2 text-subtle">
          Models
          <span className="tnum">{models.size > 0 && `${models.size} selected`}</span>
          <span className="flex-1" />
          <button type="button" className="hover:text-fg" onClick={() => setModels(new Set(boot?.models ?? []))}>
            All
          </button>
          <button type="button" className="hover:text-fg" onClick={() => setModels(new Set())}>
            None
          </button>
        </p>
        <div className="space-y-0.5">
          {(boot?.models ?? []).map((model) => (
            <label
              key={model}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={models.has(model)}
                onChange={() => setModels((set) => toggle(set, model))}
                className="accent-accent"
              />
              <span className="tnum" title={model}>
                {shortModel(model)}
              </span>
            </label>
          ))}
        </div>
      </div>

      <footer className="border-t border-line px-4 py-3">
        {/* The size of the spend, before the button rather than after it. */}
        <p className="tnum mb-2 text-subtle">
          {runs === 0
            ? "Pick at least one suite and one model"
            : `${plural(suites.size, "suite")} × ${plural(models.size, "model")} = ${runs} runs${estimate(scale, runs)}`}
        </p>
        {error !== null && <p className="mb-2 text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-muted hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void launch()}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-bg transition-opacity disabled:opacity-35"
          >
            {launchLabel(sending, runs)}
          </button>
        </div>
      </footer>
    </Overlay>
  );
}
