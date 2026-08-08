import { RotateCw } from "lucide-react";
import type { LiveItem } from "../../../report/live.js";
import { GridCell } from "./GridCell.js";
import { SectionHeading } from "../Badge.js";
import { Tip } from "../Tip.js";
import { GridBox } from "../Table.js";

// One table per suite: models down the side, cases across the top, one cell per
// planned run. A real table with scoped headers rather than a div grid, so a
// screen reader can walk it the way the eye does.

/** The suite this grid is for; taken off the item so the browser never reaches into src/config.ts. */
type SuiteId = LiveItem["suite"];

/**
 * One width for every case column in every suite, so the three matrices stack
 * into one shape rather than three. Measured per suite they came out different —
 * `q01` against `card-statement-2026-05` — and a reader comparing suites was
 * comparing three different grids.
 */
const CASE_COL_CH = 10;

/**
 * Wide enough for the longest id in models.json written out in full —
 * `google/gemini-3.5-flash-lite` at 28 characters — plus the rerun button that
 * sits after it. The vendor prefix is the half that distinguishes two models
 * with similar names, so it stays.
 */
const MODEL_COL_CH = 33;

const HEAD = "block whitespace-nowrap leading-tight";

/** A case id that already opens with its own short code, as `q01` and `r01-markdown` do. */
const SHORT_CODE = /^([a-z]\d+)/;

/**
 * The header a column is labelled with. Most ids carry their code already and
 * only need trimming; one that does not — `card-statement-2026-05` — is given
 * its suite's initial and its position instead, so every column across the three
 * matrices is labelled the same width and the same way.
 *
 * Only the label is shortened. The id itself is what the tooltip says and what
 * the link carries, so nothing downstream ever sees this.
 */
function shortCase(caseId: string, suite: SuiteId, index: number): string {
  const own = SHORT_CODE.exec(caseId);
  if (own !== null) return own[1] ?? caseId;
  return `${suite.slice(0, 1)}${String(index + 1).padStart(2, "0")}`;
}

/** Joined on a separator neither id can hold, so two different pairs can never collide on one key. */
function cellKey(model: string, caseId: string): string {
  return `${model}\u0000${caseId}`;
}

function groupCells(items: LiveItem[]): Map<string, LiveItem[]> {
  const byCell = new Map<string, LiveItem[]>();
  for (const item of items) {
    const key = cellKey(item.model, item.caseId);
    const held = byCell.get(key);
    if (held === undefined) byCell.set(key, [item]);
    else held.push(item);
  }
  return byCell;
}

export function SuiteGrid({
  suite,
  items,
  onOpen,
  onRerun,
}: {
  suite: SuiteId;
  items: LiveItem[];
  onOpen: (item: LiveItem) => void;
  /**
   * Rerun these cases for this model. An empty list is the whole suite, which is
   * what the row header offers; one entry is a single cell. Absent where a rerun
   * cannot be offered at all — a matrix in flight — and then nothing shows one.
   */
  onRerun?: (model: string, caseIds: string[]) => void;
}) {
  // Plan order, not sorted order: the matrix is planned in the order a reader
  // asked for it, and re-sorting here would move a row under a moving cursor.
  const models = [...new Set(items.map((item) => item.model))];
  const caseIds = [...new Set(items.map((item) => item.caseId))];
  const byCell = groupCells(items);

  const trials = Math.max(1, ...[...byCell.values()].map((group) => group.length));

  return (
    <section>
      <SectionHeading aside={`${models.length} models × ${caseIds.length} cases`}>
        <span className="uppercase tracking-wider text-accent">{suite}</span>
      </SectionHeading>

      {/*
       * No rules between cells. The badges are already boxes, and a grid of
       * boxes inside boxes draws a cage the eye reads before it reads a single
       * number — alignment does the work the borders were doing.
       */}
      <GridBox>
        <table className="table-fixed border-collapse">
        <caption className="sr-only">{`${suite}: one row per model, one column per case`}</caption>
        <colgroup>
          <col style={{ width: `${MODEL_COL_CH}ch` }} />
          {caseIds.map((caseId) => (
            <col key={caseId} style={{ width: `${CASE_COL_CH * trials}ch` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <td />
            {caseIds.map((caseId, index) => (
              <th key={caseId} scope="col" className="px-1.5 pb-2 align-bottom font-normal text-fg">
                {/* The code is the label; the id is what hovering it answers with. */}
                <Tip label={caseId} side="top">
                  <span className={`${HEAD} mx-auto cursor-default`} tabIndex={0}>
                    {shortCase(caseId, suite, index)}
                  </span>
                </Tip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model} className="group/row">
              <th scope="row" className="tnum py-1 pr-3 text-left font-normal text-muted">
                <div className="flex min-w-0 items-center gap-1.5">
                  {/* The truncation lives on the span, never on the cell: a tooltip
                      is the cell's child and would be clipped by its own row. */}
                  <Tip label={model} side="top">
                    <span className="block min-w-0 truncate">{model}</span>
                  </Tip>
                  {/* Revealed on hover, as the reports table reveals its chevron.
                      Always in the layout, so showing it cannot shift the row. */}
                  {onRerun !== undefined && (
                    <Tip label={`Rerun the ${suite} suite for this model`} side="top">
                      <button
                        type="button"
                        aria-label={`Rerun ${suite} for ${model}`}
                        onClick={() => onRerun(model, [])}
                        className="shrink-0 text-subtle opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover/row:opacity-100"
                      >
                        <RotateCw size={11} strokeWidth={2.25} aria-hidden />
                      </button>
                    </Tip>
                  )}
                </div>
              </th>
              {caseIds.map((caseId) => (
                <td key={caseId} className="p-0 align-middle">
                  {/* Trials sit side by side in the one cell, in trial order, as the plan ran them. */}
                  <div className="flex items-center justify-center gap-1 px-1 py-1.5">
                    {(byCell.get(cellKey(model, caseId)) ?? [])
                      .toSorted((left, right) => left.trial - right.trial)
                      .map((item) => (
                        <GridCell
                          key={item.trial}
                          item={item}
                          onOpen={onOpen}
                          onRerun={onRerun === undefined ? undefined : (cell) => onRerun(cell.model, [cell.caseId])}
                        />
                      ))}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        </table>
      </GridBox>
    </section>
  );
}
