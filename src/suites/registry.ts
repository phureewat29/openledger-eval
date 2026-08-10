import { ingestSuite } from "./ingest/suite.js";
import { querySuite } from "./query/suite.js";
import { recordSuite } from "./record/suite.js";
import type { AnySuite } from "./types.js";

/**
 * A selected suite with no entry here is skipped, never fatal. Importing
 * this module has no side effects, unlike main.ts, so a test can hold the
 * whole registry to one invariant at once.
 */
export const SUITES: AnySuite[] = [ingestSuite, recordSuite, querySuite];
