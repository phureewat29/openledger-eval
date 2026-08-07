import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCostUsd } from "./record.js";
import type { RunMetrics } from "./recorder.js";

function metrics(patch: Partial<RunMetrics> = {}): RunMetrics {
  return {
    llmCalls: 4,
    toolCalls: 6,
    tokensIn: 10_000,
    tokensOut: 2_000,
    tokensEstimated: false,
    llmMs: 8_000,
    toolMs: 1_000,
    durationMs: 9_000,
    contextTrims: 0,
    ...patch,
  };
}

const PRICING = { promptUsdPerTok: 0.000_003, completionUsdPerTok: 0.000_015 };

test("prices a run from the tokens the endpoint reported", () => {
  const cost = computeCostUsd(metrics(), PRICING);
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - 0.06) < 1e-9, `expected 0.06, got ${cost}`);
});

test("prices nothing when the model list priced nothing", () => {
  assert.equal(computeCostUsd(metrics(), null), null);
});

/** A chars/4 guess billed at the real rate would read as a measurement. */
test("prices nothing when the tokens were estimated", () => {
  assert.equal(computeCostUsd(metrics({ tokensEstimated: true }), PRICING), null);
});
