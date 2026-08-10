import { readFileSync } from "node:fs";
import { tryExecute, type Result } from "./result.js";

/**
 * The read-then-parse every JSON file on disk goes through: a missing file
 * and a malformed one both come back `ok: false` the same way, so a caller
 * branches once instead of guarding the read and the parse separately.
 */
export function readJsonFile(path: string): Result<unknown> {
  const text = tryExecute(() => readFileSync(path, "utf8"));
  if (!text.ok) return { ok: false, error: `cannot read ${path}: ${text.error}` };

  const json = tryExecute(() => JSON.parse(text.value) as unknown);
  if (!json.ok) return { ok: false, error: `${path} is not JSON: ${json.error}` };

  return json;
}
