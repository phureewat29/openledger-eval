import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Result } from "../core/result.js";
import type { ChatFailure, ChatModel, ChatReply } from "../model/chat.js";
import { estimateTokens } from "../model/tokens.js";
import type { EventSink, PhaseExit, PhaseId } from "../report/events.js";
import type { SuitePhase } from "../suites/types.js";
import { attachArtifacts, type TransportPlan } from "./attach.js";
import { findTool, toolSpecs, unknownToolResult, type Tool } from "./tools.js";

// The runner's own moves (a retry, a stall prod, handing artifacts back)
// are operational events, which the eval excludes by design.

// Run-level, never per phase: a counter that restarted per phase would make
// two phases' calls look like one turn.
interface TurnCounter {
  count: number;
}

interface RunnerDeps {
  model: ChatModel;
  tools: Tool[];
  transport: TransportPlan;
  emit: EventSink;
  contextBudgetTokens: number;
  turns: TurnCounter;
}

const MAX_STALL_PRODS = 2;
const CONTINUE_PROMPT = "Continue. Use a tool or give your answer.";
const MAX_REPLY_ECHO = 4_000;
const TRIMMED_PLACEHOLDER = "[tool result dropped by the context guard]";

/**
 * Drops the OLDEST tool results first, replacing content instead of removing
 * the message, so every tool_call keeps an answer. The system prompt and the
 * user's turns are never touched, so an attachment stays for the whole run.
 */
function trimContext(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: PhaseId,
): void {
  while (estimateTokens(messages) > deps.contextBudgetTokens) {
    const index = messages.findIndex(
      (message) => message.role === "tool" && message.content !== TRIMMED_PLACEHOLDER,
    );
    const message = messages[index];
    if (message?.role !== "tool") return;
    messages[index] = { ...message, content: TRIMMED_PLACEHOLDER };
    deps.emit({ type: "context_trim", phase });
  }
}

function describe(phase: PhaseId, err: ChatFailure): string {
  return `${phase}: the endpoint failed (${err.status ?? "no status"}): ${err.message}`;
}

async function complete(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: PhaseId,
): Promise<Result<ChatReply>> {
  const specs = toolSpecs(deps.tools);
  const first = await deps.model.complete(messages, specs);
  if (first.ok) return first;
  if (first.reason !== "transient") return { ok: false, error: describe(phase, first) };

  deps.emit({
    type: "operational",
    phase,
    operation: "endpoint_retry",
    detail: `retried after ${first.status ?? "no"} status: ${first.message}`,
  });
  const second = await deps.model.complete(messages, specs);
  if (!second.ok) return { ok: false, error: describe(phase, second) };
  return second;
}

interface Invoked {
  answer: ChatCompletionMessageParam;
  attachment: ChatCompletionMessageParam | null;
  /** The tool answered for the whole phase; nothing more is asked of the model. */
  terminal: boolean;
}

/** Monotonic, so a clock the operator changes mid-run cannot make a call look instant. */
function since(started: number): number {
  return Math.round(performance.now() - started);
}

async function runToolCall(
  deps: RunnerDeps,
  phase: PhaseId,
  turn: number,
  call: { id: string; name: string; args: string },
): Promise<Invoked> {
  const tool = findTool(deps.tools, call.name);
  const started = performance.now();
  const result = tool
    ? await tool.invoke(call.args)
    : unknownToolResult(
        call.name,
        deps.tools.map((known) => known.name),
      );
  deps.emit({ type: "tool_call", phase, turn, durationMs: since(started), ...result.observation });
  for (const note of result.notes) deps.emit({ type: "operational", phase, ...note });

  const answer: ChatCompletionMessageParam = {
    role: "tool",
    tool_call_id: call.id,
    content: result.content,
  };
  const terminal = result.terminal === true;
  if (!result.artifacts) return { answer, attachment: null, terminal };

  const attached = await attachArtifacts(deps.transport, result.artifacts);
  for (const note of attached.notes) deps.emit({ type: "operational", phase, ...note });
  return { answer, attachment: attached.message, terminal };
}

/**
 * Every call in the turn is answered, terminal or not: the history carries on
 * into the next phase, and an unanswered tool_call invalidates it. Attachments
 * follow the answers and never sit between them, because a user turn in the
 * middle would leave a tool_call unanswered and the endpoint rejects the
 * request. True when a tool answered for the whole phase.
 */
async function answerToolCalls(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: PhaseId,
  turn: number,
  calls: ChatReply["toolCalls"],
): Promise<boolean> {
  const attachments: ChatCompletionMessageParam[] = [];
  let terminal = false;
  for (const call of calls) {
    const invoked = await runToolCall(deps, phase, turn, call);
    messages.push(invoked.answer);
    if (invoked.attachment) attachments.push(invoked.attachment);
    terminal = terminal || invoked.terminal;
  }
  messages.push(...attachments);
  return terminal;
}

/** A failure means the endpoint itself is unusable; everything the model gets wrong is recorded, not raised. */
export async function runPhase(
  deps: RunnerDeps,
  messages: ChatCompletionMessageParam[],
  phase: SuitePhase,
): Promise<Result<string>> {
  deps.emit({ type: "phase_start", phase: phase.id, title: phase.title });
  messages.push({ role: "user", content: phase.prompt });

  let reply = "";
  let prods = 0;
  // Only a loop that runs out of calls leaves this untouched.
  let exit: PhaseExit = "call_cap";
  for (let call = 0; call < phase.maxCalls; call++) {
    trimContext(deps, messages, phase.id);
    const started = performance.now();
    const completion = await complete(deps, messages, phase.id);
    if (!completion.ok) return completion;

    const answer = completion.value;
    deps.turns.count += 1;
    const turn = deps.turns.count;
    deps.emit({
      type: "llm_call",
      phase: phase.id,
      turn,
      content: answer.content.trim().slice(0, MAX_REPLY_ECHO),
      finishReason: answer.finishReason,
      toolCalls: answer.toolCalls.length,
      usage: answer.usage,
      durationMs: since(started),
    });
    messages.push(answer.assistant);
    if (answer.content.trim()) reply = answer.content.trim();

    if (answer.toolCalls.length > 0) {
      const terminal = await answerToolCalls(deps, messages, phase.id, turn, answer.toolCalls);
      if (!terminal) continue;
      exit = "answered";
      break;
    }

    if (answer.content.trim()) {
      exit = "answered";
      break;
    }
    if (prods >= MAX_STALL_PRODS) {
      exit = "stalled";
      break;
    }
    prods += 1;
    deps.emit({
      type: "operational",
      phase: phase.id,
      operation: "stall_prod",
      detail: `prod ${prods}: empty reply with no tool call`,
    });
    messages.push({ role: "user", content: CONTINUE_PROMPT });
  }

  deps.emit({ type: "phase_end", phase: phase.id, reply, exit });
  return { ok: true, value: reply };
}
