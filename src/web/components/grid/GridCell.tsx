import type { LiveItem, LiveItemState } from "../../../report/live-item.js";
import { duration } from "../../../shared/format.js";
import { gradeShade, isTerminal, STATE_LEGEND, type GradeShade } from "../../../shared/vocabulary.js";
import { Tip } from "../Tip.js";
import {
  ArrowUpRight,
  Circle,
  CloudOff,
  LoaderCircle,
  RotateCw,
  ServerCrash,
  type LucideIcon,
} from "lucide-react";

// One cell of the matrix, and the whole vocabulary the grid and its legend read
// from — so a legend entry can never describe a glyph that is no longer drawn.

/**
 * What a cell prints, and how loud it prints it.
 *
 * A state with a score prints the score, filled, because the number is the
 * point. A state with no score prints a mark instead — a glyph on a coloured
 * block reads as a scored cell whose number failed to render, which is exactly
 * the wrong thing for "not started yet".
 */
export interface CellFace {
  text: string;
  tone: string;
  Icon?: LucideIcon;
}

/**
 * Green for a clean pass, amber where some checks failed, red where none passed
 * — drawn as an outline over a wash of its own hue rather than a solid block. A
 * field of saturated fills reads as a warning in itself, and at this density it
 * is the numbers that should carry, not the boxes around them.
 *
 * The count is always printed inside the colour, so the grid still reads for
 * anyone who cannot separate the two warm hues.
 */
const SHADE_TONE: Record<GradeShade, string> = {
  full: "border-accent/40 bg-accent/15 text-accent",
  partial: "border-warn/40 bg-warn/15 text-warn",
  empty: "border-bad/40 bg-bad/15 text-bad",
};

/** One entry per state that carries no score of its own; graded reads its own counts instead. */
const STATE_FACE: Record<Exclude<LiveItemState, "graded">, CellFace> = {
  pending: { text: "·", tone: "border-line text-subtle", Icon: Circle },
  // Spinning rather than filled: a run still working must not look like one that
  // finished and passed.
  running: { text: "▸", tone: "border-accent/40 bg-accent/5 text-accent", Icon: LoaderCircle },
  // The two failures are told apart by their mark, not by a hue they share.
  endpoint_error: { text: "!", tone: "border-bad/40 bg-bad/15 text-bad", Icon: CloudOff },
  sandbox_error: { text: "✕", tone: "border-bad/40 bg-bad/15 text-bad", Icon: ServerCrash },
};

/**
 * Only a run that finished left a record to open. A waiting or in-flight cell
 * has nothing behind it yet, so it is not a button — offering one that opens an
 * empty sheet is worse than offering none.
 */
function hasResult(item: LiveItem): boolean {
  return isTerminal(item.state);
}

/** The counts when the run recorded them, the rate when it is an older live.json that did not. */
function gradedFace(item: LiveItem): CellFace {
  const { checksPassed, checksTotal } = item;
  if (checksPassed !== undefined && checksTotal !== undefined) {
    // 0 of 0 is a case with nothing to check, not a case that failed everything.
    const rate = checksTotal === 0 ? 1 : checksPassed / checksTotal;
    return { text: `${checksPassed}/${checksTotal}`, tone: SHADE_TONE[gradeShade(rate)] };
  }
  if (item.passRate !== null) {
    return { text: `${Math.round(item.passRate * 100)}%`, tone: SHADE_TONE[gradeShade(item.passRate)] };
  }
  // Graded carrying neither counts nor a rate is nothing this harness writes.
  return { text: "—", tone: SHADE_TONE.full };
}

export function faceOf(item: LiveItem): CellFace {
  return item.state === "graded" ? gradedFace(item) : STATE_FACE[item.state];
}

/**
 * Label and meaning stay apart rather than joined on a separator: the glyph for
 * a waiting cell is itself a middot, and two of the meanings carry an em-dash
 * already, so any punctuation between them reads as part of the glyph or as a
 * second clause. Tone does the separating instead.
 */
export interface LegendEntry {
  face: CellFace;
  label: string;
  meaning: string;
}

function stateEntry(state: Exclude<LiveItemState, "graded">): LegendEntry {
  return { face: STATE_FACE[state], ...STATE_LEGEND[state] };
}

/**
 * Graded earns three entries because its shade is the grade, and the shade is
 * what a reader is scanning. Each one is labelled by how much passed rather than
 * by the state they share — three rows all reading "scored" tell a reader
 * nothing about which is which.
 */
function gradeEntry(text: string, shade: GradeShade, label: string): LegendEntry {
  return {
    face: { text, tone: SHADE_TONE[shade] },
    label,
    meaning: `${STATE_LEGEND.graded.label}, and ${label.toLowerCase().replace(" passed", " of its checks passed")}`,
  };
}

export const LEGEND: LegendEntry[] = [
  stateEntry("pending"),
  stateEntry("running"),
  gradeEntry("12/12", "full", "All passed"),
  gradeEntry("9/12", "partial", "Some passed"),
  gradeEntry("0/12", "empty", "None passed"),
  stateEntry("endpoint_error"),
  stateEntry("sandbox_error"),
];

/** One phrasing of a score, so the hover card and the cell under it cannot disagree about one. */
function checkSummary(item: LiveItem): string | null {
  const { checksPassed, checksTotal } = item;
  if (checksPassed !== undefined && checksTotal !== undefined) {
    return `${checksPassed} of ${checksTotal} checks passed`;
  }
  return item.passRate === null ? null : `${Math.round(item.passRate * 100)}% of checks passed`;
}

/** Only what the cell knows: a waiting cell has neither checks nor a duration to report. */
function tipLines(item: LiveItem): string[] {
  const lines = [`${item.caseId} trial ${item.trial}`, STATE_LEGEND[item.state].label];
  const checks = item.state === "graded" ? checkSummary(item) : null;
  if (checks !== null) lines.push(checks);
  if (item.durationMs !== null) lines.push(duration(item.durationMs));
  return lines;
}

export function GridCell({
  item,
  onOpen,
  onRerun,
}: {
  item: LiveItem;
  onOpen: (item: LiveItem) => void;
  /** Absent where a rerun cannot be offered — a matrix in flight — and then no cell shows one. */
  onRerun?: (item: LiveItem) => void;
}) {
  const face = faceOf(item);
  const lines = tipLines(item);
  // One rule for both: a cell that finished can be opened, and is the only kind
  // there is anything to run again.
  const openable = hasResult(item);
  const rerunnable = openable && onRerun !== undefined;

  return (
    <Tip
      side="top"
      // The group lives on the anchor rather than on the cell, because the rerun
      // button below overhangs the cell's corner: held on the cell, it would
      // disappear the moment the pointer left the cell to reach it.
      className={openable ? "group/cell" : ""}
      label={lines.map((line, index) => (
        <span key={line} className={`block ${index === 0 ? "text-fg" : "text-muted"}`}>
          {line}
        </span>
      ))}
    >
      {/*
       * The button is the tab stop, and the card opens on its focus as well as
       * on hover. What the card says is the button's accessible name too, so a
       * screen reader is told it once rather than twice.
       */}
      <button
        type="button"
        disabled={!openable}
        onClick={() => onOpen(item)}
        aria-label={lines.join(", ")}
        className={`tnum relative grid h-6 w-[4.25rem] place-items-center rounded border text-[11px] leading-none transition-colors ${face.tone} ${
          openable ? "cursor-pointer hover:brightness-150" : "cursor-default"
        }`}
      >
        {face.Icon === undefined ? (
          face.text
        ) : (
          <face.Icon
            size={12}
            strokeWidth={2}
            aria-hidden
            className={item.state === "running" ? "animate-spin [animation-duration:1.6s]" : ""}
          />
        )}
        {/* Absolute, so revealing it on hover cannot nudge the column widths. */}
        {openable && (
          <ArrowUpRight
            size={8}
            strokeWidth={3}
            aria-hidden
            className="absolute right-0.5 top-0.5 opacity-0 transition-opacity group-hover/cell:opacity-80"
          />
        )}
      </button>

      {/*
       * A sibling of the cell, never a child: the cell is itself a button, and a
       * button inside one is neither valid nor clickable. It carries its own
       * name, because the cell's says "open this run" — the opposite verb.
       */}
      {rerunnable && (
        <button
          type="button"
          onClick={() => onRerun(item)}
          aria-label={`Rerun ${item.caseId} for ${item.model}`}
          className="absolute -left-1.5 -top-1.5 z-10 grid h-4 w-4 place-items-center rounded-full border border-line-strong bg-surface text-subtle opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover/cell:opacity-100"
        >
          <RotateCw size={9} strokeWidth={2.5} aria-hidden />
        </button>
      )}
    </Tip>
  );
}
