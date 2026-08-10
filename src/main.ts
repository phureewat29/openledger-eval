import { readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import * as z from "zod";
import {
  EVAL_ROOT,
  loadConfig,
  OPENROUTER_BASE_URL,
  readModelIds,
  TRIALS,
  type Config,
} from "./config.js";
import { tryExecute, type Result } from "./core/result.js";
import {
  fetchModelRows,
  validateCandidates,
  type SkippedModel,
  type ValidatedModel,
} from "./model/capabilities.js";
import { runOk, type OpenLedgerRunner } from "./oled/command.js";
import type { Benchmark, ConfigEcho } from "./report/benchmark.js";
import { formatEvent, formatRunFinish, formatRunStart } from "./report/feed.js";
import { identityDrift, mergeEcho } from "./report/merge.js";
import { readReportRecords } from "./report/read.js";
import type { RunIdentity, RunRecord } from "./report/record.js";
import { printRunLine } from "./report/run-line.js";
import { resolveReportDir, tallyStates } from "./report/write.js";
import { createReportWriters, type PriorReport } from "./report/writers.js";
import { expandPlan, runMatrix } from "./runner/matrix.js";
import { runOne, type RunEnvironment } from "./runner/run.js";
import { createSandboxRunner } from "./sandbox/session.js";
import {
  createWorkspace,
  createWorkspaceGuard,
  installSkillPack,
  type SkillPack,
  type WorkspaceGuard,
} from "./sandbox/workspace.js";
import type { SuiteId } from "./shared/vocabulary.js";
import { suiteFingerprint } from "./suites/fingerprint.js";
import { SUITES } from "./suites/registry.js";
import type { AnySuite, EvalCase } from "./suites/types.js";

const FIXTURES_DIR = join(EVAL_ROOT, "fixtures");
const REPORTS_ROOT = join(EVAL_ROOT, "reports");

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function warn(line: string): void {
  process.stderr.write(`${chalk.yellow(line)}\n`);
}

function fail(message: string): number {
  process.stderr.write(`${chalk.red(message)}\n`);
  return 1;
}

const PACKAGE = z.object({ version: z.string() });

/** Names the eval in the identity block; an unreadable version must not stop a run. */
function readEvalVersion(): string {
  const text = tryExecute(() => readFileSync(join(EVAL_ROOT, "package.json"), "utf8"));
  if (!text.ok) return "unknown";
  const parsed = tryExecute(() => PACKAGE.parse(JSON.parse(text.value)));
  return parsed.ok ? parsed.value.version : "unknown";
}

/** Every id here is already validated against SUITE_IDS, and the registry parity test guarantees the registry covers it. */
function selectSuites(ids: SuiteId[]): AnySuite[] {
  const suites: AnySuite[] = [];
  for (const id of ids) {
    const suite = SUITES.find((candidate) => candidate.id === id);
    if (suite) suites.push(suite);
  }
  return suites;
}

/** Fixture self-checks run here, before anything is packed or spent. */
function loadCases(suites: AnySuite[]): Result<Map<SuiteId, EvalCase[]>> {
  const casesBySuite = new Map<SuiteId, EvalCase[]>();
  for (const suite of suites) {
    const cases = suite.cases(FIXTURES_DIR);
    if (!cases.ok) return { ok: false, error: `${suite.id} suite: ${cases.error}` };
    casesBySuite.set(suite.id, cases.value);
  }
  return { ok: true, value: casesBySuite };
}

/**
 * Named cases, or every case when none was named. An id no selected suite
 * carries is a usage error rather than an empty suite: a rerun that quietly
 * matched nothing would report a clean pass over zero runs.
 */
function selectCases(
  casesBySuite: ReadonlyMap<SuiteId, EvalCase[]>,
  wanted: string[],
): Result<Map<SuiteId, EvalCase[]>> {
  if (wanted.length === 0) return { ok: true, value: new Map(casesBySuite) };

  const selected = new Map<SuiteId, EvalCase[]>();
  const known = new Set<string>();
  for (const [id, cases] of casesBySuite) {
    for (const kase of cases) known.add(kase.id);
    selected.set(
      id,
      cases.filter((kase) => wanted.includes(kase.id)),
    );
  }

  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length > 0) {
    const carried = [...known].join(", ");
    return { ok: false, error: `no such case: ${missing.join(", ")}; the selected suites carry ${carried}` };
  }
  return { ok: true, value: selected };
}

interface Bootstrap {
  oledVersion: string;
  skill: SkillPack;
}

async function readCliVersion(runner: OpenLedgerRunner): Promise<Result<string>> {
  const result = await runOk(runner, "oled --version", ["--version"]);
  if (!result.ok) return result;
  return { ok: true, value: result.value.stdout.trim() };
}

/**
 * One throwaway sandbox answers what every run is measured against: the version
 * of the installed CLI and the skill text it ships, captured once for the whole
 * matrix. A missing `oled` fails here, before a single token is spent.
 */
async function bootstrap(guard: WorkspaceGuard): Promise<Result<Bootstrap>> {
  const created = createWorkspace();
  if (!created.ok) return created;

  const workspace = created.value;
  guard.register(workspace);
  try {
    const runner = createSandboxRunner(workspace);
    const version = await readCliVersion(runner);
    if (!version.ok) {
      return { ok: false, error: `${version.error}; install it with \`npm install -g oled\`, or \`npm link\` a local build` };
    }

    const skill = await installSkillPack(workspace, runner);
    if (!skill.ok) return skill;
    return { ok: true, value: { oledVersion: version.value, skill: skill.value } };
  } finally {
    guard.release(workspace);
  }
}

/**
 * A suite whose cases are only complete once a real ledger has answered them
 * says so here: after bootstrap, because it needs the installed CLI, and before
 * the plan, because a refusal must cost nothing.
 */
async function resolveCases(
  suites: AnySuite[],
  casesBySuite: ReadonlyMap<SuiteId, EvalCase[]>,
  guard: WorkspaceGuard,
): Promise<Result<Map<SuiteId, EvalCase[]>>> {
  const resolved = new Map(casesBySuite);
  for (const suite of suites) {
    const cases = resolved.get(suite.id) ?? [];
    if (!suite.resolve || cases.length === 0) continue;

    say(chalk.dim(`${suite.id}: deriving its goldens from a seeded ledger`));
    const answered = await suite.resolve(cases, guard);
    if (!answered.ok) return { ok: false, error: `${suite.id} suite: ${answered.error}` };
    resolved.set(suite.id, answered.value);
  }
  return { ok: true, value: resolved };
}

interface Invocation {
  config: Config;
  startedAt: Date;
  models: ValidatedModel[];
  skipped: SkippedModel[];
  suites: AnySuite[];
  casesBySuite: Map<SuiteId, EvalCase[]>;
  /** The ids actually validated against, after models.json filled in for an absent --model. */
  modelsRequested: string[];
  /** config.concurrency if set, else one lane per validated model, capped at 8. */
  concurrency: number;
}

function toConfigEcho(config: Config, modelsRequested: string[], concurrency: number): ConfigEcho {
  return {
    suites: config.suites,
    trials: TRIALS,
    concurrency,
    modelsRequested,
  };
}

/**
 * Written to the console and to the feed, both of which are machine-level
 * surfaces, so the harness names itself by its package rather than its brand.
 */
function identityLine(identity: RunIdentity): string {
  return (
    `oled ${identity.oledVersion} · skill ${identity.skillVersion} ` +
    `${identity.skillSha256.slice(0, 12)} · openledger-eval ${identity.evalVersion}`
  );
}

function modelsLine(models: ValidatedModel[]): string {
  return `models: ${models.map((model) => model.id).join(", ")}`;
}

function skippedLine(model: SkippedModel): string {
  return `skipped ${model.id}: ${model.reason}`;
}

function planLine(planSize: number, concurrency: number): string {
  return `${planSize} runs at concurrency ${concurrency}`;
}

/** What the operator is told at startup, so the feed opens with the same facts the console did. */
function headerLines(
  invocation: Invocation,
  identity: RunIdentity,
  planSize: number,
  priorRuns: number,
): string[] {
  const into = invocation.config.into;
  return [
    identityLine(identity),
    modelsLine(invocation.models),
    ...invocation.skipped.map(skippedLine),
    planLine(planSize, invocation.concurrency),
    ...(into === null ? [] : [`rerun into ${into}, merging with ${priorRuns} runs`]),
  ];
}

function reportOutcome(records: RunRecord[]): number {
  for (const record of records) {
    if (record.state === "graded") continue;
    warn(`${record.model} · ${record.suite} · ${record.caseId}: ${record.state}: ${record.error}`);
  }
  const states = tallyStates(records);
  say(
    `graded ${states.graded} · endpoint errors ${states.endpoint_error} · sandbox errors ${states.sandbox_error}`,
  );
  return states.endpoint_error + states.sandbox_error > 0 ? 1 : 0;
}

/** What the writers need of an existing report, plus the benchmark whose config echo this invocation merges into. */
interface Merge extends PriorReport {
  benchmark: Benchmark;
}

/**
 * Admits this invocation into an existing report, and says how the two differ.
 *
 * The drift check is the whole of it: a report's identity block promises that
 * every number in it was measured against one build of oled and one SKILL.md,
 * and a rerun measured against another would keep the promise's words while
 * quietly breaking its meaning. Refusing costs a fresh iteration; merging costs
 * a regression trail nobody can trust again.
 */
function openMerge(dir: string, benchmark: Benchmark, identity: RunIdentity): Merge {
  const drift = identityDrift(benchmark.identity, identity);
  // Said out loud and then merged anyway. A rerun always lands in the report it
  // came from, so refusing here would leave nowhere for it to go; what the
  // report cannot do is average across builds without admitting it.
  if (drift !== null) warn(`this report now ${drift}`);

  const { records, unreadable } = readReportRecords(dir);
  // Loud, and then on: an unreadable record is a paid run about to vanish from
  // the leaderboard, and the operator is the only one who can tell whether that
  // matters more than the rerun they asked for.
  for (const reason of unreadable) warn(`${reason}; it will be missing from the merged benchmark`);
  return { benchmark, records, drift };
}

async function runInvocation(invocation: Invocation): Promise<number> {
  const { config, concurrency } = invocation;
  const fingerprint = suiteFingerprint(FIXTURES_DIR);
  if (!fingerprint.ok) return fail(fingerprint.error);

  const guard = createWorkspaceGuard();
  const booted = await bootstrap(guard);
  if (!booted.ok) return fail(booted.error);

  const identity: RunIdentity = {
    startedAt: invocation.startedAt.toISOString(),
    oledVersion: booted.value.oledVersion,
    skillVersion: booted.value.skill.version,
    skillSha256: booted.value.skill.sha256,
    suiteSha256: fingerprint.value,
    evalVersion: readEvalVersion(),
  };
  say(identityLine(identity));

  const casesBySuite = await resolveCases(invocation.suites, invocation.casesBySuite, guard);
  if (!casesBySuite.ok) return fail(casesBySuite.error);

  const plan = expandPlan(invocation.models, invocation.suites, casesBySuite.value, TRIALS);
  if (plan.length === 0) return fail("the selected suites carry no cases, so there is nothing to run");
  say(planLine(plan.length, concurrency));

  const resolved = resolveReportDir(REPORTS_ROOT, invocation.startedAt, config.into);
  if (!resolved.ok) return fail(resolved.error);
  const { dir, prior } = resolved.value;

  const merged = prior === null ? null : openMerge(dir, prior, identity);
  const echo = toConfigEcho(config, invocation.modelsRequested, concurrency);
  const writers = createReportWriters({
    dir,
    identity: merged?.benchmark.identity ?? identity,
    config: merged === null ? echo : mergeEcho(merged.benchmark.config, echo),
    skippedModels: invocation.skipped,
    plan,
    openedAt: invocation.startedAt,
    prior: merged,
    header: headerLines(invocation, identity, plan.length, merged?.records.length ?? 0),
  });

  const env: RunEnvironment = {
    apiKey: config.apiKey,
    baseUrl: OPENROUTER_BASE_URL,
    stream: config.stream,
    timeoutMs: config.timeoutMs,
    inputModalities: config.inputModalities,
    skillText: booted.value.skill.text,
    guard,
    onEvent: (planned, event) => {
      const line = formatEvent(planned, event, new Date());
      if (line) writers.feed.line(line);
    },
  };
  await runMatrix(
    plan,
    {
      runOne: (planned) => runOne(planned, env),
      onStart: (planned) => {
        writers.live.start(planned);
        writers.feed.line(formatRunStart(planned, new Date()));
      },
      onProgress: (record) => {
        writers.sink.add(record);
        printRunLine(record);
        writers.live.finish(record);
        writers.feed.line(formatRunFinish(record, new Date()));
      },
    },
    concurrency,
  );

  const closed = writers.close();
  if (!closed.ok) return fail(closed.error);
  say(chalk.dim(`report: ${dir}`));
  say(closed.value);
  // The sink holds what finished, so an interrupt reports from the same records a clean finish does.
  return reportOutcome(writers.sink.records());
}

/** Nothing is packed, installed or spent until every candidate and fixture has been answered for. */
async function run(config: Config, startedAt: Date): Promise<number> {
  const ids = config.models.length > 0 ? { ok: true as const, value: config.models } : readModelIds();
  if (!ids.ok) return fail(ids.error);

  const rows = await fetchModelRows(OPENROUTER_BASE_URL);
  if (!rows.ok) return fail(`${rows.error}; nothing has been spent, so try again`);

  const { validated, skipped } = validateCandidates(rows.value, ids.value);
  for (const model of skipped) warn(skippedLine(model));
  if (validated.length === 0) return fail("no candidate model is usable, so there is nothing to run");
  say(modelsLine(validated));

  const suites = selectSuites(config.suites);

  const loaded = loadCases(suites);
  if (!loaded.ok) return fail(loaded.error);

  const casesBySuite = selectCases(loaded.value, config.cases);
  if (!casesBySuite.ok) return fail(casesBySuite.error);

  // One lane per validated model by default, so the matrix runs several models
  // at once; capped at 8 so a long model list cannot flood the sandbox host.
  const concurrency = config.concurrency ?? Math.min(Math.max(validated.length, 2), 8);

  // A named iteration is answered for before anything is packed: a mistyped slug
  // should cost a sentence rather than an install. Reading is all this does —
  // the directory for an ordinary run is still created after bootstrap, so a
  // failed one leaves no report behind.
  if (config.into !== null) {
    const target = resolveReportDir(REPORTS_ROOT, startedAt, config.into);
    if (!target.ok) return fail(target.error);
  }

  return runInvocation({
    config,
    startedAt,
    models: validated,
    skipped,
    suites,
    casesBySuite: casesBySuite.value,
    modelsRequested: ids.value,
    concurrency,
  });
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2), process.env);
  if (config.ok) return run(config.value, new Date());
  process.stderr.write(`${config.message}\n`);
  return 2;
}

const finished = await tryExecute(main);
process.exitCode = finished.ok ? finished.value : fail(finished.error);
