import type { ReactNode } from "react";

// One look for every table, so a leaderboard, a checks list and a process tree
// read as the same kind of object.

/** Header cell: the quietest row on the table, since the data is the point. */
export const TH = "whitespace-nowrap bg-surface-2/50 px-3.5 py-2 text-left font-normal text-subtle";

export const TD = "px-3.5 py-2 align-top";

/**
 * A table in a box of its own, scrolling sideways rather than pushing the page.
 *
 * Not for the run matrix: its hover cards are absolutely positioned, and an
 * `overflow` ancestor clips them. That grid uses `GridBox` below and lets the
 * page's own scroll region carry the width.
 */
export function TableBox({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded-lg border border-line bg-surface ${className}`}>{children}</div>
  );
}

/**
 * Padding for anything inside a panel that is not a table. A table brings its
 * own in every cell, so the panel itself carries none — which leaves a bare
 * sentence sitting on the border unless it says so.
 */
export function PanelBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`px-3.5 py-3 ${className}`}>{children}</div>;
}

/**
 * The same frame without the clipping, for anything that puts a card over its
 * edge — the grid's hover cards and its header tooltips both do.
 *
 * It must never be given an overflow. CSS has no `overflow-x: auto` with
 * `overflow-y: visible`: setting either to a non-visible value forces the other
 * to `auto`, so a wrapper made to scroll sideways silently starts clipping
 * upward as well, and every card drawn above a cell disappears into it. A grid
 * too wide for the window scrolls the page's own region instead.
 */
export function GridBox({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-surface p-3.5 ${className}`}>{children}</div>;
}
