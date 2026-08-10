import { uniq } from "es-toolkit";
import type { Result } from "../../core/result.js";
import { isSuiteId, SUITE_IDS, type SuiteId } from "../../shared/vocabulary.js";

// The whitelist between a browser and a process argv. A request that fails these
// checks never becomes a command line, so nothing here has to know what a
// process is.

export interface LaunchRequest {
  suites: SuiteId[];
  models: string[];
}

/**
 * The whitelist between an HTML form and a process argv: a suite that is not
 * ours and a model id that is not already in models.json never reach spawn, so
 * no submitted string can become a command-line argument on its own.
 */
export function parseLaunchRequest(form: URLSearchParams, modelIds: string[]): Result<LaunchRequest> {
  const suites = uniq(form.getAll("suite"));
  if (suites.length === 0) return { ok: false, error: "pick at least one suite" };

  const strange = suites.filter((suite) => !isSuiteId(suite));
  if (strange.length > 0) {
    return { ok: false, error: `not a suite: ${strange.join(", ")}` };
  }

  const models = uniq(form.getAll("model"));
  if (models.length === 0) return { ok: false, error: "pick at least one model" };

  const unknown = models.filter((model) => !modelIds.includes(model));
  if (unknown.length > 0) return { ok: false, error: `not a model in models.json: ${unknown.join(", ")}` };

  return { ok: true, value: { suites: suites.filter(isSuiteId), models } };
}

/** --suite repeats, one per ticked box, except that every box ticked is the flag the CLI spells "all". */
function suiteFlags(suites: SuiteId[]): string[] {
  if (suites.length === SUITE_IDS.length) return ["--suite", "all"];
  return suites.flatMap((suite) => ["--suite", suite]);
}

/** The argv a terminal run would use, so a dashboard launch and `npm run eval` cannot drift apart. */
export function spawnArgs(request: LaunchRequest): string[] {
  return [
    "run",
    "eval",
    "--",
    ...suiteFlags(request.suites),
    ...request.models.flatMap((model) => ["--model", model]),
  ];
}

/**
 * One model's cases of one suite, run again into the report they came from.
 * An empty `cases` is the whole suite for that model — the grid's row — and one
 * entry is a single cell; the two scopes the dashboard offers are the same
 * request, so nothing downstream has to tell them apart.
 */
export interface RerunRequest {
  slug: string;
  model: string;
  suite: SuiteId;
  cases: string[];
}

/** What a case id may look like before it is allowed to become an argument. */
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/i;

/** The same whitelist parseLaunchRequest applies, for the one route that names a case. */
export function parseRerunRequest(
  slug: string,
  body: { model: string; suite: string; cases?: string[] },
  modelIds: string[],
): Result<RerunRequest> {
  if (!isSuiteId(body.suite)) return { ok: false, error: `not a suite: ${body.suite}` };
  if (!modelIds.includes(body.model)) {
    return { ok: false, error: `not a model in models.json: ${body.model}` };
  }

  const cases = uniq(body.cases ?? []);
  const strange = cases.filter((id) => !CASE_ID.test(id));
  if (strange.length > 0) return { ok: false, error: `not a case id: ${strange.join(", ")}` };

  return { ok: true, value: { slug, model: body.model, suite: body.suite, cases } };
}

export function rerunArgs(request: RerunRequest): string[] {
  return [
    "run",
    "eval",
    "--",
    "--into",
    request.slug,
    "--suite",
    request.suite,
    "--model",
    request.model,
    ...request.cases.flatMap((id) => ["--case", id]),
  ];
}
