import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A hover card for something that shows only a mark, or that has more to say
// than it has room for.
//
// It renders into `document.body` rather than beside its trigger, and this is
// the whole point of the component. A card positioned inside the layout is
// clipped by any ancestor with an overflow, and this app needs several: the
// shell clips so the page cannot scroll and take the rail with it, the main
// region scrolls so it is the only thing that does, and tables scroll sideways
// rather than pushing the page. Every one of those is correct on its own and
// every one of them silently eats a card drawn near its edge — CSS has no way
// to scroll one axis and let content escape the other. A portal steps outside
// the whole question.
//
// The cost is measuring on open, which is why the card exists only while it is
// shown; nothing is positioned, and no listener runs, until a pointer or the
// keyboard arrives.

type Side = "right" | "top";

const GAP = 8;

interface At {
  top: number;
  left: number;
  transform: string;
}

function place(box: DOMRect, side: Side): At {
  if (side === "right") {
    return { top: box.top + box.height / 2, left: box.right + GAP, transform: "translateY(-50%)" };
  }
  return { top: box.top - GAP, left: box.left + box.width / 2, transform: "translate(-50%, -100%)" };
}

export function Tip({
  label,
  side = "right",
  children,
  className = "",
}: {
  label: ReactNode;
  side?: Side;
  children: ReactNode;
  className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<At | null>(null);

  const show = useCallback(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (box !== undefined) setAt(place(box, side));
  }, [side]);

  const hide = useCallback(() => setAt(null), []);

  return (
    <span
      ref={anchor}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className={`relative flex ${className}`}
    >
      {children}
      {at !== null &&
        createPortal(
          <span
            role="tooltip"
            style={{ top: at.top, left: at.left, transform: at.transform }}
            className="pointer-events-none fixed z-[100] max-w-[22rem] rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] leading-4 text-muted shadow-lg"
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
