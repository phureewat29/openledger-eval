import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveDoc } from "../../report/live.js";
import type { LivePayload } from "../../shared/payloads.js";
import { liveIsShowing } from "./live-route.js";

const SLUG = "2026-08-09-0051";

/** Only the four fields the rule reads; the rest of a payload has no say in it. */
function payload(over: Partial<LivePayload>): LivePayload {
  return {
    kind: "running-fresh",
    slug: SLUG,
    doc: {} as LiveDoc,
    hasBenchmark: false,
    slot: {} as LivePayload["slot"],
    stop: { kind: "none" },
    hold: { kind: "none" },
    notice: null,
    ...over,
  };
}

test("hands a run that has not scored itself over to the live screen", () => {
  assert.equal(liveIsShowing(payload({}), SLUG), true);
});

/**
 * The report page is what a finished matrix is for, and the newest finished run
 * is the one most likely to be opened. Handing that one over would leave no way
 * to read it at all.
 */
test("keeps a scored report on its own page, however live the channel says it is", () => {
  assert.equal(liveIsShowing(payload({ hasBenchmark: true }), SLUG), false);
});

test("says nothing about an iteration the channel is not following", () => {
  assert.equal(liveIsShowing(payload({ slug: "2026-08-10-0900" }), SLUG), false);
  assert.equal(liveIsShowing(payload({ slug: null }), SLUG), false);
  assert.equal(liveIsShowing(null, SLUG), false);
});

/** Nothing to hand over: the live screen would have no grid to draw either. */
test("keeps the page when the channel is following a run with no document", () => {
  assert.equal(liveIsShowing(payload({ doc: null }), SLUG), false);
});

/**
 * A stale or paused run is handed over too. The live screen names each of those
 * plainly, where this page could only repeat that it is waiting.
 */
test("hands over a stale or paused run as readily as a beating one", () => {
  assert.equal(liveIsShowing(payload({ kind: "running-stale" }), SLUG), true);
  assert.equal(liveIsShowing(payload({ kind: "running-paused" }), SLUG), true);
});
