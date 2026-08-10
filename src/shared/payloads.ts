import type { LiveDoc } from "../report/live.js";
import type { LiveState } from "../server/live-state.js";
import type { FeedLine } from "./feed.js";

// What each channel pushes. Type-only: these cross the wire as JSON and the
// `welcome` protocol version is what tells a stale tab to reload, so there is no
// second schema to keep in step with the first.

/** The kind alone; the live document travels beside it rather than inside it. */
export type LiveStateKind = LiveState["kind"];

// Wire shapes the server conforms to. launch.ts, procs.ts and sandboxes.ts
// import these back rather than declaring their own, so a payload and the
// value the server builds for it can never drift apart.

export interface SlotExit {
  code: number | null;
  at: string;
}

/** A snapshot of the slot as plain data; views and decisions never reach into the slot itself. */
export interface SlotView {
  alive: boolean;
  launchedAt: string | null;
  stoppedAt: string | null;
  exit: SlotExit | null;
  /** The group every process of this run belongs to; null when the slot holds nothing. */
  pgid: number | null;
  /** Last lines of the launch log, read only for a child that died badly; empty otherwise. */
  tail: string;
}

/** What a stop would reach: the child in the slot, a run known only by its report, or nothing at all. */
export type StopTarget = { kind: "owned" } | { kind: "foreign"; pid: number } | { kind: "none" };

/** Which way a run can be held right now: the two are never both on offer. */
export type PauseAction = "pause" | "resume";

export type PauseTarget = { kind: "none" } | { kind: PauseAction; owned: boolean; pid: number };

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** The `stat` column verbatim — `S`, `Ss`, `R+`, `T`, `Z` — read by isStopped and shown as-is. */
  state: string;
  /** Percent of one core, as ps reports it. */
  cpu: number;
  rssBytes: number;
  elapsedSec: number;
  command: string;
}

/** How a sandbox was judged to belong to something, so the panel can say why. */
export type Owner = "argv" | "runner" | "none";

export interface SandboxInfo {
  path: string;
  name: string;
  bytes: number;
  /** Since the directory was made, which for an abandoned sandbox is when its run began. */
  ageMs: number;
  /** Whatever still owns it, or `none` — the only value cleanup will act on. */
  owner: Owner;
}

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
}

export interface FeedPayload {
  slug: string | null;
  lines: FeedLine[];
  offset: number;
  /** The file restarted, so these lines replace what the reader holds rather than extending it. */
  reset: boolean;
  error: string | null;
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
