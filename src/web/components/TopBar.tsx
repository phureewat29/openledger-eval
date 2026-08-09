import { Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { LivePayload } from "../../shared/payloads.js";
import { post } from "../lib/api.js";
import { Badge, type Tone } from "./Badge.js";
import { HoldButton } from "./HoldButton.js";
import { duration, elapsedOf, progressOf } from "../lib/format.js";

// The run's vitals, and the one control that stops it. Progress is the bar's own
// bottom edge rather than a component of its own: it is always there, it costs
// no vertical space, and it reads at a glance from across the room.

const STATE_LABEL: Record<string, string> = {
  none: "No runs yet",
  starting: "Starting",
  failed: "Launch failed",
  "running-fresh": "Running",
  "running-paused": "Paused",
  "running-stale": "No heartbeat",
  done: "Finished",
};

/** Green is alive, yellow is uncertain, red is broken; a finished run needs no colour at all. */
const STATE_TONE: Record<string, Tone> = {
  none: "muted",
  starting: "accent",
  failed: "bad",
  "running-fresh": "accent",
  // Amber, not green: a held run is neither working nor broken, and the accent
  // means alive. Nothing about it will change until someone acts.
  "running-paused": "warn",
  "running-stale": "warn",
  done: "muted",
};

/** Ticks only while something is moving, so a finished run costs no renders. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function TopBar({ live }: { live: LivePayload | null }) {
  const kind = live?.kind ?? "none";
  const moving = kind === "running-fresh" || kind === "starting";
  const now = useNow(moving);

  // Neither cost nor tokens are here: live.json carries neither, they are figures
  // a benchmark computes once a run is scored. The bar showed a placeholder
  // em-dash for one and hid the other behind a constant zero, which is a promise
  // of two numbers and the delivery of none. The iteration page has both.
  const { done, total, percent } = progressOf(live?.doc ?? null);
  const spent = live?.doc?.items.length ? elapsedOf(live.doc, now) : 0;
  const stoppable = live?.stop.kind !== undefined && live.stop.kind !== "none";

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-4 border-b border-line px-4">
      <span className="tnum truncate text-muted">{live?.slug ?? "—"}</span>

      <Badge tone={STATE_TONE[kind] ?? "muted"} dot pulse={moving}>
        {STATE_LABEL[kind] ?? kind}
      </Badge>

      <div className="flex-1" />

      {total > 0 && (
        <div className="tnum flex items-center gap-4 text-muted">
          <span title="runs finished">
            {done}
            <span className="text-subtle">/{total}</span>
          </span>
          <span title="elapsed">{duration(spent)}</span>
        </div>
      )}

      {live !== null && <HoldButton hold={live.hold} doc={live.doc} />}

      {stoppable && (
        <button
          type="button"
          onClick={() => void post("/api/stop", {})}
          className="flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-muted transition-colors hover:border-bad hover:text-bad"
        >
          <Square size={11} strokeWidth={2.5} fill="currentColor" />
          Stop
        </button>
      )}

      {/* The progress bar is the border, so it never competes for space. */}
      <span
        className="absolute inset-x-0 bottom-0 h-0.5 bg-accent transition-[width] duration-500"
        style={{ width: `${percent}%` }}
        aria-hidden
      />
    </header>
  );
}
