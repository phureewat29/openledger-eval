import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import type { OpenLedgerRunner } from "../oled/command.js";

// Never touches the caller's real ~/.oled: the tree carries its own home, and
// the CLI resolves every default it has from there.
export interface Workspace {
  root: string;
  home: string;
  data: string;
  cwd: string;
  cache: string;
  agent: string;
  /** npm --global --prefix target for the packed CLI. */
  npm: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
}

export interface SkillPack {
  path: string;
  version: string;
  sha256: string;
  length: number;
  text: string;
}

const DIRS = ["home", "data", "cwd", "cache", "agent", "npm"] as const;

/**
 * The home redirect is the whole isolation mechanism. Since 0.21.0 the CLI
 * reads no environment configuration at all: every default it has — the config
 * file, the database, the data and cache directories, context.md — resolves
 * under `homedir()`, which is `$HOME`. A run therefore cannot reach the
 * operator's own ledger, and two runs cannot reach each other's, because each
 * has its own home. The paths that must not merely be isolated but known are
 * pinned again on the command line at init.
 */
function buildEnv(paths: Omit<Workspace, "env">): NodeJS.ProcessEnv {
  const bin = join(paths.npm, "bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Prepended: an `oled` on the operator's global PATH must never win over the packed one.
    PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    NO_COLOR: "1",
  };
  // Node warns on stderr when NO_COLOR and FORCE_COLOR are both set, and that
  // warning breaks the one-JSON-object-per-stderr-line contract the tool layer
  // parses. Inheriting either from the operator would corrupt a run's output.
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  // 0.21.0 reads none of these, but the harness packs whatever checkout it is
  // pointed at: against an older CLI an inherited OLED_DIR would send the run
  // to the operator's own ledger. Dropped rather than merely left unset.
  for (const key of Object.keys(env)) {
    if (key.startsWith("OLED_")) delete env[key];
  }
  return env;
}

export function createWorkspace(): Result<Workspace> {
  const created = tryExecute(() => {
    const root = mkdtempSync(join(tmpdir(), "oled-eval-"));
    const paths = {
      root,
      home: join(root, "home"),
      data: join(root, "data"),
      cwd: join(root, "cwd"),
      cache: join(root, "cache"),
      agent: join(root, "agent"),
      npm: join(root, "npm"),
      dbPath: join(root, "db.sqlite"),
    };
    for (const dir of DIRS) mkdirSync(paths[dir], { recursive: true });
    return { ...paths, env: buildEnv(paths) };
  });
  if (!created.ok) return { ok: false, error: `cannot create workspace: ${created.error}` };
  return created;
}

// Only the source files travel: a fixture's fact or golden file stays out of every path the model can reach.
export function seedFiles(workspace: Workspace, files: string[], subdir: string): Result<string[]> {
  const seeded = tryExecute(() => {
    const dir = join(workspace.data, subdir);
    mkdirSync(dir, { recursive: true });
    return files.map((source) => {
      const dest = join(dir, basename(source));
      copyFileSync(source, dest);
      return dest;
    });
  });
  if (!seeded.ok) return { ok: false, error: `cannot seed ${subdir}: ${seeded.error}` };
  return seeded;
}

/** The system prompt is the INSTALLED file, so its hash and length are what
 *  the report can be trusted against. */
export async function installSkillPack(
  workspace: Workspace,
  runner: OpenLedgerRunner,
): Promise<Result<SkillPack>> {
  const setup = await runner.run(["setup", "--dir", workspace.agent, "--json"]);
  if (!setup.ok) return { ok: false, error: `oled setup did not run: ${setup.message}` };
  if (setup.value.exitCode !== 0) {
    return {
      ok: false,
      error: `oled setup exited ${setup.value.exitCode}: ${setup.value.stderr.trim()}`,
    };
  }

  const dir = join(workspace.agent, "openledger");
  const pack = tryExecute(() => {
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    return {
      path: join(dir, "SKILL.md"),
      version: readFileSync(join(dir, "VERSION"), "utf8").trim(),
      sha256: createHash("sha256").update(text).digest("hex"),
      length: text.length,
      text,
    };
  });
  if (!pack.ok) return { ok: false, error: `cannot read the installed skill: ${pack.error}` };
  return pack;
}

function disposeWorkspace(workspace: Workspace): void {
  rmSync(workspace.root, { recursive: true, force: true });
}

export interface WorkspaceGuard {
  register(workspace: Workspace): void;
  /**
   * A directory removed on exit however the process ends. A signal exits
   * through process.exit, which skips pending finally blocks, so a caller's
   * own cleanup cannot be trusted to run.
   */
  registerPath(path: string): void;
  /** Call on a clean finish, once the workspace has nothing left to answer for. */
  release(workspace: Workspace): void;
}

/** Holds every live workspace, so a run that fans out concurrently still cleans up all of them on exit. */
export function createWorkspaceGuard(): WorkspaceGuard {
  const live = new Set<Workspace>();
  const paths = new Set<string>();

  const cleanupAll = (): void => {
    for (const workspace of live) disposeWorkspace(workspace);
    live.clear();
    for (const path of paths) rmSync(path, { recursive: true, force: true });
    paths.clear();
  };

  process.on("exit", cleanupAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanupAll();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }

  return {
    register(workspace) {
      live.add(workspace);
    },
    registerPath(path) {
      paths.add(path);
    },
    release(workspace) {
      if (!live.delete(workspace)) return;
      disposeWorkspace(workspace);
    },
  };
}
