import type { LivePayload } from "../../shared/payloads.js";

// Which of the two screens owns an iteration. A run still writing itself belongs
// to the live view, which has its grid, feed and controls; a run that has scored
// itself belongs to its report. Kept apart from the route so the rule can be
// stated once and tested without a browser.

/**
 * Whether the Live screen is already showing this iteration, and showing it
 * better than its own page could.
 *
 * A scored report is never handed over, however live it is — a finished matrix
 * is exactly what the report page is for. So this is only ever true of a run
 * that has not scored itself, which is also the only state the report page had
 * nothing to say about.
 *
 * Matching on the slug alone is sound because of a rule two layers down:
 * `resolveReportDir` refuses to merge a rerun into a directory holding no
 * benchmark.json. So "live and never scored" can only describe a first-ever run,
 * which is always the newest directory — and `newestLive` follows the newest
 * directory holding a live.json. The two therefore name the same run.
 */
export function liveIsShowing(live: LivePayload | null, slug: string): boolean {
  if (live === null || live.slug !== slug) return false;
  return live.doc !== null && !live.hasBenchmark;
}
