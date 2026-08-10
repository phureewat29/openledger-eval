import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { omitBy, uniq } from "es-toolkit";
import * as z from "zod";
import { readJsonFile } from "./core/fs.js";
import type { Result } from "./core/result.js";
import { MODALITIES, MODALITIES_ENV, type Modality } from "./model/capabilities.js";
import { ITERATION_SLUG_RE, SUITE_IDS, type SuiteId } from "./shared/vocabulary.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface Config {
  apiKey: string;
  stream: boolean;
  timeoutMs: number;
  /** Declared by hand for an endpoint that publishes no model list; null probes instead. */
  inputModalities: Modality[] | null;
  /** Repeatable --suite, in the order given; every id in SUITE_IDS when none was. */
  suites: SuiteId[];
  /** Repeatable --model; [] means every id in models.json. */
  models: string[];
  /** Repeatable --case; [] means every case of every selected suite. */
  cases: string[];
  /**
   * An existing iteration slug to merge this invocation into, from --into.
   * null is the ordinary case: a new timestamped directory of its own.
   */
  into: string | null;
  /** null: one lane per validated model, capped at 8; --concurrency overrides. */
  concurrency: number | null;
}

/** Every way a config can fail is a usage error, which main exits 2 on. */
interface ConfigFailure {
  ok: false;
  message: string;
}

type ConfigResult = { ok: true; value: Config } | ConfigFailure;

/** This repo's own root: fixtures, models.json and reports all hang off it. */
export const EVAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * One run per case, and no way to ask for more: a second trial doubles a
 * matrix that already costs real money, and rerunning the whole invocation
 * says the same thing when a result looks unstable.
 */
export const TRIALS = 1;

const MODELS_FILE = join(EVAL_ROOT, "models.json");

const CANDIDATES = z.array(z.string().min(1)).min(1);

/** The candidate list every entry point starts from: the CLI when no --model is passed, the dashboard form always. */
export function readModelIds(): Result<string[]> {
  const json = readJsonFile(MODELS_FILE);
  if (!json.ok) return json;

  const parsed = CANDIDATES.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: `${MODELS_FILE}: ${z.prettifyError(parsed.error)}` };
  return { ok: true, value: parsed.data };
}

/** A comma list, so one bad value fails at startup instead of mid-run. */
const MODALITY_LIST = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(z.enum(MODALITIES)).min(1));

const ENV_SPEC = z.object({
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  LLM_STREAM: z.enum(["true", "false"]).default("true"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  [MODALITIES_ENV]: MODALITY_LIST.optional(),
});

interface Flags {
  /** Empty means no --suite was passed, which loadConfig reads as every suite. */
  suites: SuiteId[];
  models: string[];
  cases: string[];
  into: string | null;
  concurrency: number | null;
}

function usage(message: string): ConfigFailure {
  return { ok: false, message };
}

/** One --suite names one suite; "all" names them all, which is what selecting every box means. */
function parseSuite(value: string): SuiteId[] | null {
  if (value === "all") return [...SUITE_IDS];
  return (SUITE_IDS as string[]).includes(value) ? [value as SuiteId] : null;
}

function parsePositiveInt(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function setSuite(flags: Flags, value: string): string | null {
  const suites = parseSuite(value);
  if (!suites) return `--suite must be ${SUITE_IDS.join(", ")}, or all, got ${value}`;
  flags.suites = uniq([...flags.suites, ...suites]);
  return null;
}

function addModel(flags: Flags, value: string): string | null {
  flags.models.push(value);
  return null;
}

function addCase(flags: Flags, value: string): string | null {
  flags.cases.push(value);
  return null;
}

function setInto(flags: Flags, value: string): string | null {
  // Checked here rather than where it is joined onto a path: a slug is the
  // one flag that names a directory, and a bad one must never reach one.
  if (!ITERATION_SLUG_RE.test(value)) {
    return `--into must be an iteration like 2026-08-09-0051, got ${value}`;
  }
  flags.into = value;
  return null;
}

function setConcurrency(flags: Flags, value: string): string | null {
  const concurrency = parsePositiveInt(value);
  if (!concurrency) return `--concurrency must be a positive integer, got ${value}`;
  flags.concurrency = concurrency;
  return null;
}

/** One handler per recognized flag: a flag missing here is refused rather than silently accepted. */
const FLAGS: Record<string, (flags: Flags, value: string) => string | null> = {
  "--suite": setSuite,
  "--model": addModel,
  "--case": addCase,
  "--into": setInto,
  "--concurrency": setConcurrency,
};

const VALUE_FLAGS = new Set(Object.keys(FLAGS));

function parseFlags(argv: string[]): { ok: true; value: Flags } | ConfigFailure {
  const flags: Flags = {
    suites: [],
    models: [],
    cases: [],
    into: null,
    concurrency: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!VALUE_FLAGS.has(arg)) return usage(`unknown flag: ${arg}`);

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("-")) return usage(`${arg} needs a value`);
    i++;

    const error = FLAGS[arg]!(flags, value);
    if (error) return usage(error);
  }
  return { ok: true, value: flags };
}

/** Drops blank env values so a `KEY=` line in .env falls back to the default. */
function presentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return omitBy(env, (value) => !value?.trim()) as Record<string, string>;
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): ConfigResult {
  const flags = parseFlags(argv);
  if (!flags.ok) return flags;

  const parsed = ENV_SPEC.safeParse(presentEnv(env));
  if (!parsed.success) return usage(z.prettifyError(parsed.error));

  const apiKey = parsed.data.OPENROUTER_API_KEY;
  if (!apiKey) return usage("no OPENROUTER_API_KEY: set it in .env (see .env.example)");

  return {
    ok: true,
    value: {
      apiKey,
      stream: parsed.data.LLM_STREAM === "true",
      timeoutMs: parsed.data.LLM_TIMEOUT_MS,
      inputModalities: parsed.data.LLM_INPUT_MODALITIES ?? null,
      suites: flags.value.suites.length > 0 ? flags.value.suites : [...SUITE_IDS],
      models: flags.value.models,
      cases: uniq(flags.value.cases),
      into: flags.value.into,
      concurrency: flags.value.concurrency,
    },
  };
}
