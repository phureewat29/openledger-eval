import { execCapture, type CommandOk, type CommandResult } from "../core/exec.js";
import type { Result } from "../core/result.js";
import { parseNdjson } from "./ndjson.js";

export interface OpenLedgerRunner {
  run(argv: string[], opts?: { stdin?: string }): Promise<CommandResult>;
}

/** Runs one command and holds it to the contract every caller repeats: it ran, and it exited 0. */
export async function runOk(
  runner: OpenLedgerRunner,
  label: string,
  argv: string[],
  opts?: { stdin?: string },
): Promise<Result<CommandOk>> {
  const result = await runner.run(argv, opts);
  if (!result.ok) return { ok: false, error: `${label} did not run: ${result.message}` };
  if (result.value.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} exited ${result.value.exitCode}: ${result.value.stderr.trim() || result.value.stdout.trim()}`,
    };
  }
  return { ok: true, value: result.value };
}

/** One `--json` read, as its lines: under --json every stdout line is one JSON object. */
export async function runNdjson(
  runner: OpenLedgerRunner,
  label: string,
  argv: string[],
): Promise<Result<Record<string, unknown>[]>> {
  const result = await runOk(runner, label, argv);
  if (!result.ok) return result;
  return { ok: true, value: parseNdjson(result.value.stdout) };
}

export function createOpenLedgerRunner(args: {
  bin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}): OpenLedgerRunner {
  return {
    run: (argv, opts = {}) =>
      execCapture(args.bin, argv, {
        cwd: args.cwd,
        env: args.env,
        timeoutMs: args.timeoutMs,
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      }),
  };
}
