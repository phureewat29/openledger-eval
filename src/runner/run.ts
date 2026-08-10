import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import * as z from "zod";
import { planHostTransport } from "../agent/attach.js";
import { runPhase } from "../agent/runner.js";
import { tryExecute, type Result } from "../core/result.js";
import { createOpenAiCompatibleModel } from "../model/chat.js";
import { resolveContextBudget, type Modality } from "../model/capabilities.js";
import { runOk, type OpenLedgerRunner } from "../oled/command.js";
import { probeLedger } from "../oled/ledger.js";
import { buildCounters } from "../report/counters.js";
import type { EventSink, RunEvent } from "../report/events.js";
import { computeCostUsd, type RunRecord, type TerminalState } from "../report/record.js";
import { createRecorder, type Recorder } from "../report/recorder.js";
import { createSandboxRunner, initConfig } from "../sandbox/session.js";
import { createWorkspace, type Workspace, type WorkspaceGuard } from "../sandbox/workspace.js";
import type { AnswerSink, CaseGrade, SuiteContext } from "../suites/types.js";
import type { PlannedRun } from "./matrix.js";

/** Shared by every run of one invocation; only the planned cell changes between them. */
export interface RunEnvironment {
  apiKey: string;
  baseUrl: string;
  stream: boolean;
  timeoutMs: number;
  inputModalities: Modality[] | null;
  /** Captured once at startup, so every run is measured against the same text. */
  skillText: string;
  guard: WorkspaceGuard;
  /** A watcher on the live event stream, for a reader outside this run; the record does not depend on it. */
  onEvent?: (planned: PlannedRun, event: RunEvent) => void;
}

interface Outcome {
  state: TerminalState;
  error: string | null;
  grade: CaseGrade | null;
}

function failure(state: TerminalState, error: string): Outcome {
  return { state, error, grade: null };
}

const CONFIG_ECHO = z.object({ ocrBaseUrl: z.string() });

/**
 * A configured OCR endpoint would turn a scanned page into text before the
 * model ever saw it, which is a different measurement from the one this suite
 * reports. The CLI leaves it unset by default, so this only has to prove the
 * default held: no inherited profile, no changed default, no stray flag.
 */
async function assertNoOcr(runner: OpenLedgerRunner): Promise<Result<void>> {
  const result = await runOk(runner, "oled config", ["config", "--json"]);
  if (!result.ok) return result;

  const line = result.value.stdout.split("\n").find((text) => text.trim() !== "") ?? "";
  const json = tryExecute(() => JSON.parse(line) as unknown);
  if (!json.ok) return { ok: false, error: `oled config emitted no readable JSON: ${json.error}` };

  const parsed = CONFIG_ECHO.safeParse(json.value);
  if (!parsed.success) {
    return { ok: false, error: `oled config emitted no readable JSON: ${z.prettifyError(parsed.error)}` };
  }
  if (parsed.data.ocrBaseUrl !== "") {
    return { ok: false, error: `the sandbox has an OCR endpoint configured: ${parsed.data.ocrBaseUrl}` };
  }
  return { ok: true, value: undefined };
}

/** The recorder is served first: what the run leaves behind must not depend on a watcher. */
function eventSink(planned: PlannedRun, env: RunEnvironment, recorder: Recorder): EventSink {
  const watch = env.onEvent;
  if (!watch) return recorder.observe;
  return (event) => {
    recorder.observe(event);
    watch(planned, event);
  };
}

async function play(
  planned: PlannedRun,
  env: RunEnvironment,
  recorder: Recorder,
  workspace: Workspace,
): Promise<Outcome> {
  const runner = createSandboxRunner(workspace);
  const configured = await initConfig(runner, workspace);
  if (!configured.ok) return failure("sandbox_error", configured.error);

  const ocr = await assertNoOcr(runner);
  if (!ocr.ok) return failure("sandbox_error", ocr.error);

  const ctx: SuiteContext = {
    workspace,
    runner,
    skillText: env.skillText,
  };
  const prepared = await planned.suite.prepare(ctx, planned.kase);
  if (!prepared.ok) return failure("sandbox_error", prepared.error);

  const sink: AnswerSink = { submitted: null };
  const transport = planHostTransport(planned.model, env.inputModalities);
  const budget = resolveContextBudget(transport.capabilities);
  const deps = {
    model: createOpenAiCompatibleModel({
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model: planned.model.id,
      stream: env.stream,
      timeoutMs: env.timeoutMs,
    }),
    tools: planned.suite.tools(ctx, sink),
    transport,
    emit: eventSink(planned, env, recorder),
    contextBudgetTokens: budget.tokens,
    turns: { count: 0 },
  };

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: planned.suite.systemPrompt(ctx.skillText) },
  ];
  for (const phase of prepared.value) {
    const played = await runPhase(deps, messages, phase);
    if (!played.ok) return failure("endpoint_error", played.error);
  }

  const probe = await probeLedger(runner);
  if (!probe.ok) return failure("sandbox_error", probe.error);

  const snapshot = recorder.snapshot();
  return {
    state: "graded",
    error: null,
    grade: planned.suite.score({
      kase: planned.kase,
      probe: probe.value,
      metrics: snapshot.metrics,
      counters: buildCounters(snapshot.events),
      submitted: sink.submitted,
    }),
  };
}

async function execute(
  planned: PlannedRun,
  env: RunEnvironment,
  recorder: Recorder,
): Promise<Outcome> {
  const created = createWorkspace();
  if (!created.ok) return failure("sandbox_error", created.error);

  const workspace = created.value;
  env.guard.register(workspace);
  try {
    return await play(planned, env, recorder, workspace);
  } finally {
    env.guard.release(workspace);
  }
}

/**
 * Always resolves to a record: a run that ends any other way would leave its
 * cell of the matrix unaccounted for, which is the one thing a matrix cannot say.
 */
export async function runOne(planned: PlannedRun, env: RunEnvironment): Promise<RunRecord> {
  const recorder = createRecorder();
  const outcome = await tryExecute(() => execute(planned, env, recorder));
  const snapshot = recorder.snapshot();
  const settled = outcome.ok ? outcome.value : failure("sandbox_error", outcome.error);
  return {
    model: planned.model.id,
    suite: planned.suite.id,
    caseId: planned.kase.id,
    trial: planned.trial,
    state: settled.state,
    error: settled.error,
    grade: settled.grade,
    metrics: snapshot.metrics,
    counters: buildCounters(snapshot.events),
    questionsRaised: snapshot.questionsRaised,
    costUsd: computeCostUsd(snapshot.metrics, planned.model.pricing),
    events: snapshot.events,
  };
}
