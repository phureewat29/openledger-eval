import { Pause, Play } from "lucide-react";
import { useState } from "react";
import type { LiveDoc } from "../../report/live.js";
import type { PauseTarget } from "../../server/launch.js";
import { post } from "../lib/api.js";
import { Confirm } from "./Confirm.js";

// Holding a run and letting it go again. Pausing is a hard freeze — SIGSTOP to
// the whole process group — so the confirm exists to say what that does to the
// model calls already in flight, which is the one thing a reader cannot see for
// themselves. Resume asks nothing: letting a run go is what it was going to do.

const FACE = {
  pause: { label: "Pause", Icon: Pause, hover: "hover:border-warn hover:text-warn" },
  resume: { label: "Resume", Icon: Play, hover: "hover:border-accent hover:text-accent" },
} as const;

/** How many cells are mid-flight, which is exactly what a freeze would catch. */
function inFlight(doc: LiveDoc | null): number {
  return doc?.items.filter((item) => item.state === "running").length ?? 0;
}

export function HoldButton({ hold, doc }: { hold: PauseTarget; doc: LiveDoc | null }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (hold.kind === "none") return null;
  const face = FACE[hold.kind];
  const running = inFlight(doc);

  const send = async (): Promise<void> => {
    setSending(true);
    setError(null);
    const result = await post(`/api/run/${hold.kind}`, {});
    setSending(false);
    if (!result.ok) return setError(result.error);
    setConfirming(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => (hold.kind === "pause" ? setConfirming(true) : void send())}
        className={`flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-muted transition-colors ${face.hover}`}
      >
        <face.Icon size={11} strokeWidth={2.5} fill="currentColor" aria-hidden />
        {face.label}
      </button>

      {confirming && (
        <Confirm
          title="Freeze this run?"
          action="Pause"
          tone="accent"
          busy={sending}
          error={error}
          onConfirm={() => void send()}
          onCancel={() => setConfirming(false)}
        >
          <p>
            The whole run stops where it stands and nothing is lost — every cell already scored keeps its
            result, and Resume carries on from the next one.
          </p>
          {running > 0 && (
            <p>
              {running === 1 ? "One run is" : `${running} runs are`} mid-request. A freeze holds{" "}
              {running === 1 ? "it" : "them"} inside the call to the model, and the clock those calls time out
              on keeps running — so a pause of more than a few minutes can turn{" "}
              {running === 1 ? "it" : "them"} into endpoint errors when you let go.
            </p>
          )}
        </Confirm>
      )}
    </>
  );
}
