import { capitalize } from "es-toolkit";
import { typeOf } from "../../core/accounts.js";
import type { Result } from "../../core/result.js";
import type { OpenLedgerRunner } from "../../oled/command.js";
import { probeLedger } from "../../oled/ledger.js";
import { parseNdjson } from "../../oled/ndjson.js";
import type { SuiteContext } from "../types.js";
import type { SeedRow } from "./rows.js";

/**
 * The closed set of accounts the fixture rows post to. Every one is created
 * before the commit: oled answers an id it does not know by opening it as a
 * placeholder, ancestors and all, so a typo here would quietly park money in an
 * account no golden counts. The fallback to `<ccy>:expense:uncategorized` and the
 * question that comes with it are only for an id naming no account type or no
 * ledger yet open — a well-formed id in an open ledger never reaches them.
 */
const QUERY_ACCOUNTS = [
  "thb:asset:bank:kbank",
  "thb:liability:card:visa",
  "thb:income:salary",
  "thb:expense:food:restaurants",
  "thb:expense:food:groceries",
  "thb:expense:food:coffee",
  "thb:expense:transport",
  "thb:expense:utilities",
  "thb:expense:entertainment",
  "usd:asset:bank:wise",
  "usd:expense:software",
] as const;

/** `thb:expense:food:restaurants` becomes "Restaurants": a name, not an id. */
function accountName(id: string): string {
  const leaf = id.split(":").at(-1) ?? id;
  return leaf.split(/[-_]/).map(capitalize).join(" ");
}

async function createAccount(runner: OpenLedgerRunner, id: string): Promise<Result<void>> {
  const type = typeOf(id);
  if (!type) return { ok: false, error: `${id} names no account type` };

  const result = await runner.run([
    "accounts",
    "create",
    "--id",
    id,
    "--name",
    accountName(id),
    "--type",
    type,
    "--json",
  ]);
  if (!result.ok) return { ok: false, error: `creating ${id} did not run: ${result.message}` };
  if (result.value.exitCode !== 0) {
    return {
      ok: false,
      error: `creating ${id} exited ${result.value.exitCode}: ${result.value.stderr.trim()}`,
    };
  }
  return { ok: true, value: undefined };
}

function toNdjson(rows: SeedRow[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

interface CommitSummary {
  posted: number;
  failed: number;
  raised: number;
}

function summaryOf(stdout: string): CommitSummary | null {
  const row = parseNdjson(stdout).find((line) => line.type === "summary");
  if (!row || typeof row.posted !== "number") return null;
  return {
    posted: row.posted,
    failed: typeof row.failed === "number" ? row.failed : 0,
    raised: typeof row.raised_questions === "number" ? row.raised_questions : 0,
  };
}

/** Anything but a clean landing is a harness fault: the model has not been asked anything yet. */
function commitFault(summary: CommitSummary, expected: number): string | null {
  if (summary.failed > 0) return `${summary.failed} of ${expected} rows failed`;
  if (summary.raised > 0) return `the commit raised ${summary.raised} questions`;
  if (summary.posted !== expected) return `posted ${summary.posted} rows, expected ${expected}`;
  return null;
}

async function commitRows(runner: OpenLedgerRunner, rows: SeedRow[]): Promise<Result<void>> {
  const result = await runner.run(["ingest", "commit", "--json"], { stdin: toNdjson(rows) });
  if (!result.ok) return { ok: false, error: `ingest commit did not run: ${result.message}` };

  const commit = result.value;
  if (commit.exitCode !== 0) {
    return {
      ok: false,
      error: `ingest commit exited ${commit.exitCode}: ${commit.stderr.trim() || commit.stdout.trim()}`,
    };
  }

  const summary = summaryOf(commit.stdout);
  if (!summary) return { ok: false, error: "ingest commit printed no summary row" };

  const fault = commitFault(summary, rows.length);
  return fault === null ? { ok: true, value: undefined } : { ok: false, error: `seeding: ${fault}` };
}

/** Accounts first, then one batch: the goldens only hold if every row lands where it was written to. */
export async function seedLedger(ctx: SuiteContext, rows: SeedRow[]): Promise<Result<void>> {
  for (const id of QUERY_ACCOUNTS) {
    const created = await createAccount(ctx.runner, id);
    if (!created.ok) return created;
  }

  const committed = await commitRows(ctx.runner, rows);
  if (!committed.ok) return committed;

  const probe = await probeLedger(ctx.runner);
  if (!probe.ok) return probe;
  if (probe.value.questionsOpen > 0) {
    return { ok: false, error: `seeding left ${probe.value.questionsOpen} questions open` };
  }
  if (probe.value.postedRows !== rows.length) {
    return {
      ok: false,
      error: `seeding left ${probe.value.postedRows} rows in the ledger, expected ${rows.length}`,
    };
  }
  return { ok: true, value: undefined };
}
