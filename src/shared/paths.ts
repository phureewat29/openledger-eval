// Paths both programs name. The server writes them and the page tells a reader
// where to look, so they are stated once rather than spelled the same twice.
//
// Free of `node:` imports, like everything else in shared/ — see vocabulary.ts
// for what a stray one costs the browser bundle.

/**
 * Where a launched run's stdout and stderr go, relative to the repo root.
 *
 * Deliberately outside `reports/`. The dashboard watches that directory
 * shallowly to notice a new iteration, and a log living inside it woke the
 * watcher on every line the runner printed — each wake re-listing every
 * iteration and re-parsing a live.json to compare one string.
 */
export const LAUNCH_LOG = "logs/dashboard-launch.log";

/** The files and the one directory an iteration under reports/<ts>/ is made of. */
export const BENCHMARK_FILE = "benchmark.json";
export const LIVE_FILE = "live.json";
export const FEED_FILE = "feed.ndjson";
export const RUNS_DIR = "runs";
export const LEADERBOARD_FILE = "leaderboard.md";
