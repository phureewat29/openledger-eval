import { sum } from "es-toolkit";
import { EXIT, exitName } from "../oled/contract.js";
import type { RejectionType, RunEvent } from "./events.js";

// Where a run met friction, counted rather than classified: a taxonomy of
// what the friction meant would be a claim this eval cannot check.

export interface RunCounters {
  /** Calls the harness refused before anything ran. */
  rejected: Record<RejectionType, number>;
  /** Non-zero oled exits, keyed by the contract's name for the code. */
  nonzeroExits: Record<string, number>;
  /** Calls that read `--help` instead of doing work. */
  helpCalls: number;
  /**
   * Re-runs of a command already run in this run, one per repeat. A piped batch is
   * part of the command, so two commits of different rows are two commands. A
   * refused call ran nothing, so it is not one.
   */
  repeatedCommands: number;
  contextTrims: number;
}

type ToolCallEvent = Extract<RunEvent, { type: "tool_call" }>;

/** One entry per RejectionType: a new kind fails to compile until it is counted. */
const NO_REJECTIONS: Record<RejectionType, number> = {
  unknown_tool: 0,
  bad_tool_args: 0,
  refused_shell: 0,
  refused_placeholder: 0,
  refused_command: 0,
};

// Whole words: `--host` is not a request for help.
const HELP_FLAG = /(^|\s)(--help|-h)(\s|$)/;

function isToolCall(event: RunEvent): event is ToolCallEvent {
  return event.type === "tool_call";
}

/** Spacing only, so `status  --json` and `status --json` count as the same command. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * argv is not the whole command when a batch travels on stdin. Two `ingest commit`
 * calls carrying different rows are different work, and a suite whose method is a
 * sequence of commits with different payloads would otherwise read as a run that
 * did the same thing over and over.
 */
function commandKey(call: ToolCallEvent): string {
  const command = normalizeCommand(call.command);
  return call.stdinDigest === null ? command : `${command} ${call.stdinDigest}`;
}

function countRejections(calls: ToolCallEvent[]): Record<RejectionType, number> {
  const counts = { ...NO_REJECTIONS };
  for (const call of calls) {
    if (call.rejected) counts[call.rejected] += 1;
  }
  return counts;
}

function countNonzeroExits(calls: ToolCallEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    if (call.exitCode === null || call.exitCode === EXIT.OK) continue;
    const name = exitName(call.exitCode);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** Refusals across every kind, so a run page and a scorecard cannot report different totals. */
export function rejectedTotal(counters: RunCounters): number {
  return sum(Object.values(counters.rejected));
}

/** The nonzero exits by the contract's name for each, or "none". */
export function exitTally(counters: RunCounters): string {
  const entries = Object.entries(counters.nonzeroExits);
  if (entries.length === 0) return "none";
  return entries.map(([name, count]) => `${name}×${count}`).join(", ");
}

export function buildCounters(events: RunEvent[]): RunCounters {
  const calls = events.filter(isToolCall);
  const commands = calls.filter((call) => call.exitCode !== null).map(commandKey);
  return {
    rejected: countRejections(calls),
    nonzeroExits: countNonzeroExits(calls),
    helpCalls: calls.filter((call) => HELP_FLAG.test(call.args)).length,
    repeatedCommands: commands.length - new Set(commands).size,
    contextTrims: events.filter((event) => event.type === "context_trim").length,
  };
}
