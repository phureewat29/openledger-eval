import type { FeedLine } from "../report/feed.js";
import type { LiveDoc } from "../report/live.js";
import type { PauseTarget, SlotView, StopTarget } from "../server/launch.js";
import type { LiveState } from "../server/live-state.js";
import type { ProcInfo } from "../server/procs.js";
import type { SandboxInfo } from "../server/sandboxes.js";

// What each channel pushes. Type-only: these cross the wire as JSON and the
// `welcome` protocol version is what tells a stale tab to reload, so there is no
// second schema to keep in step with the first.

/** The kind alone; the live document travels beside it rather than inside it. */
export type LiveStateKind = LiveState["kind"];

export interface LivePayload {
  kind: LiveStateKind;
  slug: string | null;
  doc: LiveDoc | null;
  /** benchmark.json exists, which outranks `doc.status` for deciding a run is over. */
  hasBenchmark: boolean;
  slot: SlotView;
  stop: StopTarget;
  /** Which way this run can be held, if either; the page renders its button from this alone. */
  hold: PauseTarget;
  /** Why a launch was refused, when one just was. */
  notice: string | null;
}

export interface FeedPayload {
  slug: string | null;
  lines: FeedLine[];
  offset: number;
  /** The file restarted, so these lines replace what the reader holds rather than extending it. */
  reset: boolean;
}

export interface ProcessesPayload {
  pgid: number | null;
  /** Flat, with `depth` for indentation, so the client renders rows without walking a tree. */
  rows: (ProcInfo & { depth: number })[];
  sampledAt: string;
  error: string | null;
}

export interface SandboxesPayload {
  entries: SandboxInfo[];
  reclaimableBytes: number;
  sampledAt: string;
  error: string | null;
}
