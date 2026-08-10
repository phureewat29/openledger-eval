import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FeedKind, FeedLine } from "../../../shared/feed.js";
import type { FeedPayload, LivePayload } from "../../../shared/payloads.js";
import { useChannel } from "../../lib/channel.js";

// What the runs are saying, pinned under the grid. Collapsed it is the newest
// line and a count; open it is the last few hundred. It starts shut and opens
// itself the moment a run begins.

/** The server's own ring holds 500, so keeping more than it will ever send is pointless. */
const MAX_LINES = 500;

/**
 * Feed lines are not unique by `at` — eight runs can speak inside the same
 * millisecond — and an index key breaks the moment the buffer is trimmed from
 * the front. Arrival order is the only stable name a line has.
 */
interface Numbered {
  seq: number;
  line: FeedLine;
}

/** One entry per FeedKind: what the model said reads at full strength, the scaffolding around it does not. */
const KIND_TONE: Record<FeedKind, string> = {
  header: "text-subtle",
  run: "text-subtle",
  phase: "text-subtle",
  note: "text-subtle",
  tool: "text-muted",
  result: "text-muted",
  says: "text-fg",
};

/** The three openings a line takes when something went wrong; nothing else in the feed earns red. */
const TROUBLE = /^(endpoint_error|sandbox_error|scored 0\/)/;

function toneOf(line: FeedLine): string {
  const reportable = line.kind === "result" || line.kind === "note";
  return reportable && TROUBLE.test(line.text) ? "text-bad" : KIND_TONE[line.kind];
}

/** Local wall time at a fixed width: the run's own ISO stamp is no use to someone watching it happen. */
function clockOf(at: string): string {
  const when = new Date(at);
  return [when.getHours(), when.getMinutes(), when.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * The channel hands over an append, or a replacement when the run rolled over to
 * a feed file of its own. Keyed on the payload object itself rather than on a
 * count, so StrictMode's second pass over this effect cannot append the same
 * lines twice.
 */
function useFeedLines(payload: FeedPayload | null): Numbered[] {
  const [lines, setLines] = useState<Numbered[]>([]);
  const nextSeq = useRef(0);
  const applied = useRef<FeedPayload | null>(null);

  useEffect(() => {
    if (payload === null || payload === applied.current) return;
    applied.current = payload;
    const arriving = payload.lines.map((line) => ({ seq: nextSeq.current++, line }));
    setLines((held) => (payload.reset ? arriving : [...held, ...arriving]).slice(-MAX_LINES));
  }, [payload]);

  return lines;
}

/**
 * Shut until a run begins, then open on its own. Watching a matrix start is the
 * one moment the commentary is worth the height it takes, and every other moment
 * it is a strip of old news under the grid.
 *
 * It opens on the transition into a run rather than on the state itself, so a
 * reader who closes it mid-run is not overruled a second later.
 */
function useOpensOnLaunch(): [boolean, (open: boolean) => void] {
  const live = useChannel<LivePayload>("live");
  const [open, setOpen] = useState(false);
  const was = useRef<string | null>(null);

  const kind = live?.kind ?? null;
  useEffect(() => {
    const starting = kind === "starting" || kind === "running-fresh";
    const before = was.current;
    was.current = kind;
    // null means this page just loaded into a run already going; that is not a
    // launch anyone here watched begin.
    if (before !== null && before !== kind && starting) setOpen(true);
  }, [kind]);

  return [open, setOpen];
}

export function ActivityDrawer() {
  const payload = useChannel<FeedPayload>("feed");
  const lines = useFeedLines(payload);
  const [open, setOpen] = useOpensOnLaunch();
  const error = payload?.error ?? null;

  const newest = lines.at(-1);
  const Chevron = open ? ChevronDown : ChevronUp;

  return (
    <section className="shrink-0 border-t border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-surface-2"
      >
        <Chevron size={13} strokeWidth={2} className="shrink-0 text-accent/60" aria-hidden />
        {error !== null ? (
          <span className="truncate text-bad">{error}</span>
        ) : newest === undefined ? (
          <span className="text-subtle">nothing said yet</span>
        ) : (
          <>
            <span className="tnum shrink-0 text-subtle">{clockOf(newest.line.at)}</span>
            <span className={`truncate ${toneOf(newest.line)}`}>{newest.line.text}</span>
          </>
        )}
        <span className="tnum ml-auto shrink-0 text-subtle" title="lines held">
          {lines.length}
        </span>
      </button>

      {/*
       * Newest first in the dom inside a reversed column: the browser paints
       * oldest at the top, opens pinned to the bottom, stays pinned as lines
       * arrive, and gives scroll-up-to-pause for nothing. None of that is worth
       * hand-rolling against a scroll listener.
       */}
      {open && (
        <div className="flex h-[min(40vh,22rem)] flex-col-reverse overflow-auto overscroll-contain px-4 pb-2">
          {lines.toReversed().map(({ seq, line }) => (
            <p key={seq} className="flex gap-2">
              <span className="tnum shrink-0 text-subtle">{clockOf(line.at)}</span>
              <span className="tnum w-[20ch] shrink-0 truncate text-subtle" title={line.scope}>
                {line.scope}
              </span>
              <span className={`min-w-0 flex-1 truncate ${toneOf(line)}`} title={line.text}>
                {line.text}
              </span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
