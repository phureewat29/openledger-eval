import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import { SUBMIT_DESCRIPTION } from "../agent/tools.js";

// What the model was asked, hashed, so a report knows whether two of its runs
// were asked the same thing.
//
// The identity block already pins the CLI and the skill, which is everything on
// the openledger side. This is the other side: reword a question or the contract
// its answer is submitted under, and a run measured before that reword is no
// longer comparable with one measured after — as q09 proved, where a prompt fix
// turned a failing case into a passing one with no model involved.

/** The files whose wording decides what a run is being asked to do. */
const FINGERPRINTED = [join("query", "questions.json")];

export function suiteFingerprint(fixturesDir: string): Result<string> {
  const hash = createHash("sha256");
  for (const relative of FINGERPRINTED) {
    const path = join(fixturesDir, relative);
    const text = tryExecute(() => readFileSync(path, "utf8"));
    if (!text.ok) return { ok: false, error: `cannot fingerprint ${path}: ${text.error}` };
    hash.update(text.value);
  }
  // The tool description is part of the question: it is where `answer` is told
  // what shape to take, and it lives in code rather than in a fixture.
  hash.update(SUBMIT_DESCRIPTION);
  return { ok: true, value: hash.digest("hex") };
}
