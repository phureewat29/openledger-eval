import type { Result } from "../core/result.js";
import { createOpenLedgerRunner, runOk, type OpenLedgerRunner } from "../oled/command.js";
import type { Workspace } from "./workspace.js";

/**
 * The CLI under test, as a user would have it: `oled` resolved from PATH, from
 * whatever `npm install -g` or `npm link` put there. The harness used to pack a
 * sibling checkout and install that tarball into every sandbox, which tied a run
 * to a source tree it had no business knowing about.
 */
const OLED_BIN = "oled";

/** Long enough for a statement extraction, short enough that a hung CLI cannot own the matrix. */
const CLI_TIMEOUT_MS = 120_000;

/** Every sandbox runs the CLI the same way: one binary, the workspace's own env and cwd. */
export function createSandboxRunner(workspace: Workspace): OpenLedgerRunner {
  return createOpenLedgerRunner({
    bin: OLED_BIN,
    env: workspace.env,
    cwd: workspace.cwd,
    timeoutMs: CLI_TIMEOUT_MS,
  });
}

/**
 * Every command that touches the ledger refuses until this has run. The three
 * paths are stated rather than defaulted, so the harness and the CLI agree on
 * where a statement is read from and a ledger written to; the home redirect
 * would keep them in the sandbox either way, but not at a path the harness knows.
 */
export async function initConfig(
  runner: OpenLedgerRunner,
  workspace: Workspace,
): Promise<Result<void>> {
  const result = await runOk(runner, "oled config --init", [
    "config",
    "--init",
    "--db",
    workspace.dbPath,
    "--data-dir",
    workspace.data,
    "--cache-dir",
    workspace.cache,
    "--json",
  ]);
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}
