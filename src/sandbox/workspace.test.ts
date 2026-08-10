import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OpenLedgerRunner } from "../oled/command.js";
import { createWorkspace, installSkillPack, type Workspace } from "./workspace.js";

/**
 * The matrix runs several candidates at once, so isolation is not a property of
 * one run but of any two. Since 0.21.0 the CLI reads no environment
 * configuration: the home redirect is the entire mechanism, which makes these
 * the assertions that keep a parallel run honest.
 */
function build(): Workspace {
  const created = createWorkspace();
  assert.ok(created.ok, created.ok ? "" : created.error);
  return created.value;
}

function dispose(...workspaces: Workspace[]): void {
  for (const workspace of workspaces) rmSync(workspace.root, { recursive: true, force: true });
}

/** `oled setup` already ran and exited 0 — only the read-back of what it installed is under test. */
const SETUP_OK: OpenLedgerRunner = {
  run: () => Promise.resolve({ ok: true, value: { argv: ["setup"], exitCode: 0, stdout: "{}", stderr: "" } }),
};

function installSkill(workspace: Workspace, text: string): string {
  const dir = join(workspace.agent, "openledger");
  const skill = join(dir, "SKILL.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(skill, text);
  writeFileSync(join(dir, "VERSION"), "2.0.0\n");
  return skill;
}

test("two workspaces share no path a run could write to", () => {
  const one = build();
  const two = build();
  try {
    for (const key of ["root", "home", "data", "cache", "dbPath", "cwd", "agent"] as const) {
      assert.notEqual(one[key], two[key], `${key} is shared between two runs`);
    }
  } finally {
    dispose(one, two);
  }
});

test("a run's home is inside its own workspace, under both names the platform uses", () => {
  const workspace = build();
  try {
    assert.equal(workspace.env.HOME, workspace.home);
    assert.equal(workspace.env.USERPROFILE, workspace.home);
    assert.ok(workspace.home.startsWith(workspace.root));
  } finally {
    dispose(workspace);
  }
});

// The CLI ignored these from 0.21.0 on. Setting them again would look like
// isolation while doing nothing, which is worse than not setting them at all.
test("no OLED_* variable is set, because none is read any more", () => {
  const workspace = build();
  try {
    const oled = Object.keys(workspace.env).filter((key) => key.startsWith("OLED_"));
    assert.deepEqual(oled, []);
  } finally {
    dispose(workspace);
  }
});

/**
 * Node warns on stderr when NO_COLOR and FORCE_COLOR are both set, and that
 * warning breaks the one-JSON-object-per-stderr-line contract the tool layer
 * parses. The operator's own shell is the likely source of either.
 */
test("colour is forced off and cannot be forced back on by what the operator exported", () => {
  const workspace = build();
  try {
    assert.equal(workspace.env.NO_COLOR, "1");
    assert.ok(!("FORCE_COLOR" in workspace.env));
    assert.ok(!("CLICOLOR_FORCE" in workspace.env));
  } finally {
    dispose(workspace);
  }
});

/**
 * An empty SKILL.md would carry a valid-looking sha256 into the report while
 * every run measured only the environment adapter — refused before a token
 * is spent.
 */
test("a whitespace-only SKILL.md fails the install, naming the installed file", async () => {
  const workspace = build();
  try {
    const path = installSkill(workspace, "  \n\n");
    const pack = await installSkillPack(workspace, SETUP_OK);
    assert.equal(pack.ok, false);
    assert.ok(!pack.ok && pack.error.includes(path), "the error does not name the installed file");
  } finally {
    dispose(workspace);
  }
});

test("a real SKILL.md installs with its text, hash and trimmed version", async () => {
  const workspace = build();
  try {
    const text = "# Skill\n\nRead the ledger back.\n";
    installSkill(workspace, text);
    const pack = await installSkillPack(workspace, SETUP_OK);
    assert.ok(pack.ok, pack.ok ? "" : pack.error);
    assert.equal(pack.value.text, text);
    assert.equal(pack.value.version, "2.0.0");
    assert.equal(pack.value.sha256, createHash("sha256").update(text).digest("hex"));
  } finally {
    dispose(workspace);
  }
});
