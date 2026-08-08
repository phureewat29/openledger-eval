import { LEGEND } from "./GridCell.js";

// Always on screen and never behind a disclosure: a field of digits with nothing
// naming them is the thing this fixes. Every entry is built in GridCell.tsx from
// the same two tables the cells render from, so the legend cannot describe a
// mark or a tone that is no longer drawn — including the icons, which it takes
// from the same faces rather than restating them as glyphs.
//
// Only the mark and its name are inline. Printing each meaning as well made
// every entry long enough to claim a line of its own, and seven stacked lines
// stop being a legend and start being an essay. The meaning rides on the entry's
// `aria-label` rather than in a clipped span: a screen reader still reads it,
// and it no longer follows the legend into anyone's clipboard.

export function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {LEGEND.map((entry) => (
        <li
          key={`${entry.label} ${entry.meaning}`}
          title={entry.meaning}
          aria-label={`${entry.label} — ${entry.meaning}`}
          className="flex items-center gap-1.5 whitespace-nowrap"
        >
          <span
            className={`tnum inline-grid h-6 min-w-[4.5ch] place-items-center border border-line px-1 text-[11px] ${entry.face.tone}`}
          >
            {entry.face.Icon === undefined ? (
              entry.face.text
            ) : (
              <entry.face.Icon size={12} strokeWidth={2} aria-hidden />
            )}
          </span>
          <span className="text-subtle">{entry.label}</span>
        </li>
      ))}
    </ul>
  );
}
