import { useEffect, useState } from "react";

// Small hooks with no domain of their own — anything specific enough to import
// a report or shared type belongs beside that domain instead.

/**
 * Ticks once a second while active, so a caller ageing something off a
 * timestamp can derive it without running its own interval. Costs no renders
 * once `active` goes false.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Calls `onEscape` for as long as `active`, and never leaks a listener past it or past unmount. */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onEscape]);
}
