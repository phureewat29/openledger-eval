import chalk from "chalk";
import type { RunRecord, TerminalState } from "./record.js";

const STATE_COLOR: Record<TerminalState, (text: string) => string> = {
  graded: chalk.green,
  endpoint_error: chalk.yellow,
  sandbox_error: chalk.red,
};

/** Written as each run finishes: a matrix of long runs has to show it is moving. */
export function printRunLine(record: RunRecord): void {
  const grade = record.grade ? `${Math.round(record.grade.passRate * 100)}%` : "—";
  const trial = record.trial > 1 ? ` t${record.trial}` : "";
  process.stdout.write(
    `${chalk.bold(record.model)} · ${record.suite} · ${record.caseId}${trial} · ` +
      `${STATE_COLOR[record.state](record.state)} · ${grade} · ` +
      `${(record.metrics.durationMs / 1_000).toFixed(1)}s\n`,
  );
}
