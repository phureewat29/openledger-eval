import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import type { PlannedRun } from "../runner/matrix.js";
import type { FeedKind, FeedLine } from "../shared/feed.js";
import { duration } from "../shared/format.js";
import { FEED_FILE } from "../shared/paths.js";
import { countChecks } from "../suites/types.js";
import type { CommitCounters, RunEvent } from "./events.js";
import type { RunRecord, TerminalState } from "./record.js";
import { warnOnce } from "./warn.js";

// One line per thing worth reading, appended to reports/<ts>/feed.ndjson while a
// matrix runs, so a reader watches the runs talk instead of watching dots change
// colour. Append-only rather than an array inside live.json, which is rewritten
// whole on every transition: an ingest run fires ~70 events and eight can be in
// flight at once.

/** One screen line: a feed nobody can scan is no better than the dots it replaces. */
const MAX_TEXT = 200;

/** Header lines belong to the invocation, not to any one cell of the matrix. */
const HEADER_SCOPE = "eval";

/** Model replies arrive with their own newlines, and a feed line is read as one line. */
function cap(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TEXT) return flat;
  return `${flat.slice(0, MAX_TEXT - 1)}…`;
}

function feedLine(now: Date, scope: string, kind: FeedKind, text: string): FeedLine {
  return { at: now.toISOString(), scope, kind, text: cap(text) };
}

/** `google/gemini-3.6-flash` → `gemini-3.6-flash`: the vendor never tells two lines apart. */
function shortModel(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf("/") + 1);
}

/** Trial is shown only past the first, as printRunLine does, since most matrices run one. */
function scopeOf(modelId: string, caseId: string, trial: number): string {
  return `${shortModel(modelId)} ${caseId}${trial > 1 ? ` t${trial}` : ""}`;
}

type ToolCallEvent = Extract<RunEvent, { type: "tool_call" }>;

/** An in-process tool's subcommand is its own name, and `submit_answer submit_answer` reads as a stutter. */
function commandOf(event: ToolCallEvent): string {
  return event.tool === event.subcommand ? event.subcommand : `${event.tool} ${event.subcommand}`;
}

/** oled writes `{"error":{"message":…}}` to stderr, and the envelope alone would fill the line. */
function plainMessage(message: string): string {
  const parsed = tryExecute(() => JSON.parse(message) as unknown);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return message;
  const inner = (parsed.value as { error?: { message?: unknown } }).error?.message;
  return typeof inner === "string" && inner.length > 0 ? inner : message;
}

/** Past `posted`, a zero is dropped: a commit that duplicated or failed nothing has nothing to report. */
function commitDetails(commit: CommitCounters): string[] {
  const details = [`${commit.posted} posted`];
  if (commit.duplicates > 0) details.push(`${commit.duplicates} duplicates`);
  if (commit.failed > 0) details.push(`${commit.failed} failed`);
  if (commit.questionsRaised > 0) details.push(`${commit.questionsRaised} questions`);
  return details;
}

/** Counters first: a long error message must not push the numbers past the cap. */
function toolDetails(event: ToolCallEvent): string[] {
  const details: string[] = [];
  if (event.rows !== null) details.push(`${event.rows} rows`);
  if (event.commit) details.push(...commitDetails(event.commit));
  // A partial commit's message is its summary row, which the counters have already said in words.
  if (!event.ok && !event.commit) details.push(plainMessage(event.message));
  if (event.hint) details.push(`hint: ${event.hint}`);
  return details;
}

function toolText(event: ToolCallEvent): string {
  const command = commandOf(event);
  if (event.rejected) return `${command} refused: ${event.rejected} · ${plainMessage(event.message)}`;
  // No exit code past a refusal means no process finished - a timeout, or an
  // in-process tool like submit_answer - and the message is all that happened.
  if (event.exitCode === null) return `${command} → ${plainMessage(event.message)}`;
  return [`${command} → exit ${event.exitCode}`, ...toolDetails(event)].join(" · ");
}

type TextOf<K extends RunEvent["type"]> = (event: Extract<RunEvent, { type: K }>) => string | null;

/** One entry per RunEvent member: a new event type fails to compile until it has a line, or an explicit null. */
const TEXT: { [K in RunEvent["type"]]: TextOf<K> } = {
  phase_start: (event) => `phase ${event.phase}`,
  phase_end: (event) => `phase ${event.phase} ended: ${event.exit}`,
  // A tool-only turn says nothing, and a blank `says` line is worse than no line.
  llm_call: (event) => event.content.trim() || null,
  tool_call: toolText,
  context_trim: () => "trimmed the oldest turns to fit the context window",
  operational: (event) => `${event.operation}: ${event.detail}`,
};

/** One entry per RunEvent member, so a reader styles a line without re-deriving what it is. */
const KIND: Record<RunEvent["type"], FeedKind> = {
  phase_start: "phase",
  phase_end: "phase",
  llm_call: "says",
  tool_call: "tool",
  context_trim: "note",
  operational: "note",
};

export function formatEvent(planned: PlannedRun, event: RunEvent, now: Date): FeedLine | null {
  const textOf = TEXT[event.type] as TextOf<RunEvent["type"]>;
  const text = textOf(event);
  if (text === null) return null;
  const scope = scopeOf(planned.model.id, planned.kase.id, planned.trial);
  return feedLine(now, scope, KIND[event.type], text);
}

export function formatRunStart(planned: PlannedRun, now: Date): FeedLine {
  const scope = scopeOf(planned.model.id, planned.kase.id, planned.trial);
  return feedLine(now, scope, "run", "started");
}

function failureText(record: RunRecord): string {
  return `${record.state}: ${record.error ?? "no error was recorded"}`;
}

/** One entry per TerminalState; only `graded` has checks to report, the other two say who failed. */
const RESULT_TEXT: Record<TerminalState, (record: RunRecord) => string> = {
  graded: (record) => {
    const { passed, total } = countChecks(record.grade?.assertions ?? []);
    return `scored ${passed}/${total} checks · ${duration(record.metrics.durationMs)}`;
  },
  endpoint_error: failureText,
  sandbox_error: failureText,
};

export function formatRunFinish(record: RunRecord, now: Date): FeedLine {
  const scope = scopeOf(record.model, record.caseId, record.trial);
  return feedLine(now, scope, "result", RESULT_TEXT[record.state](record));
}

export function formatHeader(text: string, now: Date): FeedLine {
  return feedLine(now, HEADER_SCOPE, "header", text);
}

export interface FeedWriter {
  header(lines: string[]): void;
  line(line: FeedLine): void;
}

/** One append per batch, so two runs writing at once cannot tear each other's lines. */
function appendFeed(dir: string, lines: FeedLine[]): Result<void> {
  const path = join(dir, FEED_FILE);
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const written = tryExecute(() => appendFileSync(path, body));
  if (!written.ok) return { ok: false, error: `cannot append to ${path}: ${written.error}` };
  return { ok: true, value: undefined };
}

/**
 * Appends every line straight through to reports/<ts>/feed.ndjson. A failed
 * append is reported once via `warnOnce` and retried silently after.
 */
export function createFeedWriter(dir: string): FeedWriter {
  const warn = warnOnce();

  function persist(lines: FeedLine[]): void {
    const written = appendFeed(dir, lines);
    if (!written.ok) warn(`${written.error}; will keep retrying silently`);
  }

  return {
    header(lines) {
      const now = new Date();
      persist(lines.map((text) => formatHeader(text, now)));
    },
    line(line) {
      persist([line]);
    },
  };
}
