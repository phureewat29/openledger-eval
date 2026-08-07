import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { createWorkspace, type Workspace } from "./workspace.js";

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

test("two workspaces share no path a run could write to", () => {
  const one = build();
  const two = build();
  try {
    for (const key of ["root", "home", "data", "cache", "dbPath", "cwd", "agent", "npm"] as const) {
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

test("the packed CLI wins over an oled already on the operator's PATH", () => {
  const workspace = build();
  try {
    assert.ok(workspace.env.PATH?.startsWith(`${workspace.npm}/bin`));
  } finally {
    dispose(workspace);
  }
});
