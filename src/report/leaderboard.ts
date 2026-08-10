import { uniq } from "es-toolkit";
import { duration, tokens, usd } from "../shared/format.js";
import type { SuiteId } from "../shared/vocabulary.js";
import type { Benchmark, BenchmarkEntry } from "./benchmark.js";

// Renders a Benchmark straight to the markdown an operator reads. The ranking
// already happened in benchmark.ts; this file only formats what it produced.

export const MEDALS = ["🥇", "🥈", "🥉"];

export function passRateCell(entry: BenchmarkEntry): string {
  const pct = `${(entry.meanPassRate * 100).toFixed(1)}%`;
  return entry.stddevPassRate === null ? pct : `${pct} ±${(entry.stddevPassRate * 100).toFixed(1)}`;
}

function notesCell(entry: BenchmarkEntry): string {
  const failed = entry.terminal.endpoint_error + entry.terminal.sandbox_error;
  return failed > 0 ? `⚠ ${failed} failed runs` : "";
}

/** Medals go to the first three rows in table order. */
export function rankCell(position: number): string {
  const medal = MEDALS[position - 1] ?? null;
  return medal ? `${position} ${medal}` : `${position}`;
}

export const LEADERBOARD_COLUMNS: readonly string[] = [
  "#",
  "Model",
  "Cases",
  "Pass rate",
  "Avg time",
  "Avg tokens",
  "Cost",
  "Tool calls",
  "Notes",
];

/**
 * One cell array per entry, aligned to LEADERBOARD_COLUMNS and ranked by
 * position in `entries`, which must already be one suite's ranked rows. Only
 * the markdown table renders from this directly — the dashboard's HTML table
 * builds its own JSX rows, but imports MEDALS, rankCell and passRateCell from
 * this file so the two never format the same number two different ways.
 */
export function suiteRows(entries: BenchmarkEntry[]): string[][] {
  return entries.map((entry, index) => [
    rankCell(index + 1),
    entry.model,
    `${entry.cases.passed}/${entry.cases.total}`,
    passRateCell(entry),
    duration(entry.avgDurationMs),
    `${tokens(entry.avgTokens.in)} / ${tokens(entry.avgTokens.out)}`,
    usd(entry.totalCostUsd),
    entry.avgToolCalls.toFixed(1),
    notesCell(entry),
  ]);
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function suiteTable(entries: BenchmarkEntry[]): string {
  const rows = suiteRows(entries).map((cells) => tableRow(cells));
  const separator = LEADERBOARD_COLUMNS.map(() => "---");
  return [tableRow(LEADERBOARD_COLUMNS), tableRow(separator), ...rows].join("\n");
}

function suiteSection(suite: SuiteId, entries: BenchmarkEntry[]): string {
  const rows = entries.filter((entry) => entry.suite === suite);
  return `## ${suite}\n\n${suiteTable(rows)}`;
}

function identityBlock(benchmark: Benchmark): string {
  const { identity, config } = benchmark;
  return [
    `oled \`${identity.oledVersion}\` · skill \`${identity.skillVersion}\` \`${identity.skillSha256.slice(0, 12)}\` · ` +
      `prompts \`${identity.suiteSha256.slice(0, 12)}\` · eval \`${identity.evalVersion}\``,
    `suites: ${config.suites.join(", ")} · trials: ${config.trials} · concurrency: ${config.concurrency}`,
    // Only when there is something to say: an ordinary report carries no such line.
    ...(benchmark.buildDrift === null ? [] : [`\n> **This report ${benchmark.buildDrift}.** A rerun landed here measured against something else.`]),
  ].join("\n");
}

function skippedSection(skipped: Benchmark["skippedModels"]): string {
  if (skipped.length === 0) return "";
  const lines = skipped.map((model) => `- ${model.id} — ${model.reason}`);
  return `\n\n## Skipped models\n\n${lines.join("\n")}`;
}

/** Suite order follows first appearance in entries, which buildBenchmark already ranked by config.suites. */
export function renderLeaderboard(benchmark: Benchmark): string {
  const sections = uniq(benchmark.entries.map((entry) => entry.suite)).map((suite) =>
    suiteSection(suite, benchmark.entries),
  );
  return (
    `# openledger eval — ${benchmark.identity.startedAt}\n\n${identityBlock(benchmark)}\n\n` +
    sections.join("\n\n") +
    skippedSection(benchmark.skippedModels)
  );
}
