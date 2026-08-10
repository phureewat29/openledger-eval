import { HeartCrack } from "lucide-react";
import { useState } from "react";
import type { LivePayload } from "../../../shared/payloads.js";
import { RUN_STATE_LEGEND } from "../../../shared/vocabulary.js";
import { post } from "../../lib/api.js";
import { Badge, Callout } from "../Badge.js";
import { Section } from "./Section.js";

/**
 * A run that was killed outright leaves live.json saying "running" for ever, and
 * that frozen document is enough to refuse every later launch. This is the way
 * out — offered only once the run is provably gone.
 */
export function Crashed({ live }: { live: LivePayload | null }) {
  const [note, setNote] = useState<string | null>(null);
  if (live === null || live.kind !== "running-stale" || live.slug === null) return null;

  const finish = async (): Promise<void> => {
    const result = await post(`/api/iterations/${live.slug ?? ""}/finish`, {});
    setNote(result.ok ? "marked finished" : result.error);
  };

  return (
    <Section title="Crashed Run" icon={HeartCrack}>
      <Callout tone="warn">
        <Badge tone="warn">{RUN_STATE_LEGEND["running-stale"].label}</Badge>{" "}
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
