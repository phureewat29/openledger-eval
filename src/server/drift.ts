import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tryExecute } from "../core/result.js";
import { shortSha } from "../report/merge.js";
import type { RunIdentity } from "../report/record.js";

// Whether a rerun may merge into the report it names, decided here so a refusal
// costs an HTTP round trip rather than a spawn, a pack and an install.
//
// This check is advisory, and deliberately partial: it compares the one hash a
// server can reach without building anything. The runner compares both hashes
// against what it actually installed and refuses there too, which is the
// authority — so this can be wrong in only one direction, letting through a
// rerun the CLI then stops.

/** Where `oled setup` takes the skill from, which is what its installed hash is a hash of. */
const SKILL_SOURCE = ["skills", "openledger", "SKILL.md"];

export interface Drift {
  what: string;
  pinned: string;
  current: string;
}

/** null when the source cannot be read at all, which is not evidence of drift either way. */
function currentSkillSha(oledRepoRoot: string): string | null {
  const text = tryExecute(() => readFileSync(join(oledRepoRoot, ...SKILL_SOURCE), "utf8"));
  if (!text.ok) return null;
  return createHash("sha256").update(text.value).digest("hex");
}

/**
 * Why merging into that report should be refused now, or null to let the runner
 * decide. Reading nothing is a null: an openledger that has moved its skill
 * source would otherwise turn every rerun into a refusal the CLI disagrees with.
 */
export function driftAgainst(pinned: RunIdentity, oledRepoRoot: string): Drift | null {
  const current = currentSkillSha(oledRepoRoot);
  if (current === null || current === pinned.skillSha256) return null;
  return { what: "SKILL.md", pinned: shortSha(pinned.skillSha256), current: shortSha(current) };
}
