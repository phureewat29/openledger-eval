import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBMIT_DESCRIPTION } from "../agent/tools.js";
import { tryExecute, type Result } from "../core/result.js";
import { ENVIRONMENT_ADAPTER } from "./adapter.js";
import { PROMPTS as INGEST_PROMPTS } from "./ingest/suite.js";
import { SUBMIT_PARAGRAPH } from "./query/suite.js";
import { PROMPTS as RECORD_PROMPTS } from "./record/suite.js";

// Every prompt the model is shown and every fixture it is shown about, hashed,
// so a reworded ask is visible as a different build.
//
// The identity block already pins the CLI and the skill, which is everything on
// the openledger side. This is the other side: reword a prompt or a fixture, and
// a run measured before that reword is no longer comparable with one measured
// after — as q09 proved, where a prompt fix turned a failing case into a passing
// one with no model involved. Every file under each suite's fixture directory is
// hashed wholesale, so a new fixture is covered automatically instead of by a
// curated list that can fall quietly out of date.

// The tool description is part of the question: it is where `answer` is told
// what shape to take, and it lives in code rather than in a fixture.
const FIXED_PROMPTS = [ENVIRONMENT_ADAPTER, ...INGEST_PROMPTS, ...RECORD_PROMPTS, SUBMIT_PARAGRAPH, SUBMIT_DESCRIPTION];

const SUITE_DIRS = ["ingest", "record", "query"];

/** Sorted, depth-first: the same tree always yields the same file order to hash. */
function listFiles(dir: string, relative: string): Result<string[]> {
  const entries = tryExecute(() => readdirSync(dir, { withFileTypes: true }));
  if (!entries.ok) return { ok: false, error: `cannot list ${dir}: ${entries.error}` };

  const files: string[] = [];
  for (const entry of entries.value.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entryRelative = join(relative, entry.name);
    if (entry.isDirectory()) {
      const nested = listFiles(join(dir, entry.name), entryRelative);
      if (!nested.ok) return nested;
      files.push(...nested.value);
    } else {
      files.push(entryRelative);
    }
  }
  return { ok: true, value: files };
}

export function suiteFingerprint(fixturesDir: string): Result<string> {
  const hash = createHash("sha256");
  for (const dir of SUITE_DIRS) {
    const files = listFiles(join(fixturesDir, dir), dir);
    if (!files.ok) return { ok: false, error: `cannot fingerprint ${join(fixturesDir, dir)}: ${files.error}` };
    for (const relative of files.value) {
      const path = join(fixturesDir, relative);
      const bytes = tryExecute(() => readFileSync(path));
      if (!bytes.ok) return { ok: false, error: `cannot fingerprint ${path}: ${bytes.error}` };
      hash.update(relative);
      hash.update(bytes.value);
    }
  }
  for (const prompt of FIXED_PROMPTS) hash.update(prompt);

  return { ok: true, value: hash.digest("hex") };
}
