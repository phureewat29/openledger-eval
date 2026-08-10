import type { ReactNode } from "react";
import type { RunEvent } from "../../../report/events.js";
import { plural } from "../../lib/format.js";

// The raw event log behind one run's grade, collapsed by default — a reader
// wants the verdict first and the transcript only when it disagrees with them.

const PRE =
  "tnum mt-1 max-h-[22rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 p-3";

function outcomeOf(event: Extract<RunEvent, { type: "tool_call" }>): string {
  if (event.rejected !== null) return `refused: ${event.message}`;
  return event.exitCode === null ? "no exit" : `exit ${event.exitCode}`;
}

/**
 * One renderer per RunEvent variant, keyed on the same `type` field the union
 * is discriminated by — a new variant fails to compile here until it has one.
 */
const RENDER: { [K in RunEvent["type"]]: (event: Extract<RunEvent, { type: K }>) => ReactNode } = {
  phase_start: (event) => <h3 className="mt-4 text-fg">{event.title}</h3>,

  phase_end: (event) => (
    <p className="mt-1 text-subtle">
      phase {event.phase} ended — {event.exit}
    </p>
  ),

  // A tool-only turn has nothing the model said; printing an empty block would
  // just be noise between the tool calls that actually did the work.
  llm_call: (event) =>
    event.content === "" ? null : (
      <div className="mt-2">
        <p className="text-muted">turn {event.turn} · the model said</p>
        <pre className={PRE}>{event.content}</pre>
      </div>
    ),

  tool_call: (event) => {
    const outcome = outcomeOf(event);
    return (
      <div className="mt-2">
        <p className="tnum text-muted">
          turn {event.turn} · {event.command} → {outcome}
        </p>
        {event.stdin && event.stdinPreview !== null && event.stdinPreview !== "" && (
          <pre className={PRE}>{event.stdinPreview}</pre>
        )}
        <pre className={PRE}>{event.result}</pre>
        {event.hint !== null && <p className="mt-1 text-subtle">hint: {event.hint}</p>}
      </div>
    );
  },

  context_trim: () => <p className="mt-1 text-subtle">context trimmed</p>,

  operational: (event) => (
    <p className="mt-1 text-subtle">
      {event.operation} — {event.detail}
    </p>
  ),
};

/** Safe because RENDER is indexed by the exact field being dispatched on. */
function renderEvent(event: RunEvent): ReactNode {
  const render = RENDER[event.type] as unknown as (event: RunEvent) => ReactNode;
  return render(event);
}

export function Transcript({ events }: { events: RunEvent[] }) {
  const turns = events.filter((event) => event.type === "llm_call").length;

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-muted">transcript · {plural(turns, "turn")}</summary>
      <div className="mt-2">
        {events.map((event, index) => {
          const node = renderEvent(event);
          return node === null ? null : <div key={index}>{node}</div>;
        })}
      </div>
    </details>
  );
}
