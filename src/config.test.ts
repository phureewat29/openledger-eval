import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { SUITE_IDS } from "./shared/vocabulary.js";

/** The one env value with no default, so every case here is about argv alone. */
const ENV = { OPENROUTER_API_KEY: "sk-test" };

function suitesOf(...argv: string[]): string[] {
  const config = loadConfig(argv, ENV);
  assert.ok(config.ok, config.ok ? "" : config.message);
  return config.value.suites;
}

// With three suites no single value can say "ingest and query", so the flag
// repeats and accumulates the way --model already does.
test("accumulates every --suite in the order given, without repeats", () => {
  assert.deepEqual(suitesOf("--suite", "ingest", "--suite", "query"), ["ingest", "query"]);
  assert.deepEqual(suitesOf("--suite", "query", "--suite", "ingest"), ["query", "ingest"]);
  assert.deepEqual(suitesOf("--suite", "query", "--suite", "query"), ["query"]);
});

test("keeps all as the shorthand for every suite, and absence as the same thing", () => {
  assert.deepEqual(suitesOf("--suite", "all"), SUITE_IDS);
  assert.deepEqual(suitesOf(), SUITE_IDS);
  assert.deepEqual(suitesOf("--suite", "ingest", "--suite", "all"), SUITE_IDS);
});

test("refuses a suite it does not have, naming the ones it does", () => {
  const config = loadConfig(["--suite", "nope"], ENV);
  assert.equal(config.ok, false);
  assert.ok(!config.ok && config.message.includes("ingest"));
});

test("accumulates every --case in the order given, without repeats", () => {
  const config = loadConfig(["--case", "c1", "--case", "c2", "--case", "c1"], ENV);
  assert.ok(config.ok, config.ok ? "" : config.message);
  assert.deepEqual(config.ok && config.value.cases, ["c1", "c2"]);
});

test("accepts an --into value shaped like an iteration slug", () => {
  const config = loadConfig(["--into", "2026-08-09-0051"], ENV);
  assert.ok(config.ok, config.ok ? "" : config.message);
  assert.equal(config.ok && config.value.into, "2026-08-09-0051");
});

test("refuses an --into value that is not an iteration slug", () => {
  const config = loadConfig(["--into", "nope"], ENV);
  assert.equal(config.ok, false);
  assert.ok(!config.ok && config.message.includes("--into"));
});

test("refuses a flag it does not know", () => {
  const config = loadConfig(["--nope", "x"], ENV);
  assert.equal(config.ok, false);
  assert.ok(!config.ok && config.message.includes("--nope"));
});
