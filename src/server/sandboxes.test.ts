import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProcInfo } from "./procs.js";
import {
  listSandboxes,
  ownerOf,
  reclaimableBytes,
  removeSandbox,
  SANDBOX_PREFIX,
  type SandboxInfo,
} from "./sandboxes.js";

const NOW = new Date("2026-08-08T05:00:00.000Z");

/** Old enough that a sandbox made "now" is younger than the runner, and vice versa. */
const RUNNER_AGE_SEC = 600;

const SANDBOX_PATH = "/tmp/oled-eval-abc";

function proc(command: string, elapsedSec = 0): ProcInfo {
  return { pid: 1, ppid: 0, pgid: 1, state: "S", cpu: 0, rssBytes: 0, elapsedSec, command };
}

/** Stands in for the runner process every sandbox on a live matrix belongs to. */
function runner(elapsedSec = RUNNER_AGE_SEC): ProcInfo {
  return proc("node /Users/x/openledger-eval/src/main.ts --suite all", elapsedSec);
}

function box(patch: Partial<SandboxInfo> = {}): SandboxInfo {
  return { path: "/tmp/oled-eval-a", name: "oled-eval-a", bytes: 0, ageMs: 0, owner: "none", ...patch };
}

/** A throwaway root standing in for the system temp directory; awaited, so cleanup never races the body. */
async function withRoot(body: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Made now, so every runner in these cases is older than it unless said otherwise. */
const BIRTH = NOW.getTime();

test("a sandbox is owned when a live command still names its path", () => {
  const procs = [proc(`oled ingest commit --data-dir ${SANDBOX_PATH}/data --json`)];
  assert.equal(ownerOf(SANDBOX_PATH, BIRTH, procs, NOW), "argv");
});

test("a sandbox with no command naming it is still owned by a runner that predates it", () => {
  // The gap this closes: a run waiting on the model has no oled process at all,
  // and by the argv rule alone its sandbox would read as abandoned.
  assert.equal(ownerOf(SANDBOX_PATH, BIRTH, [runner()], NOW), "runner");
});

test("a sandbox older than every live runner is an orphan, because nothing running could have made it", () => {
  const olderThanTheRunner = BIRTH - (RUNNER_AGE_SEC + 60) * 1_000;
  assert.equal(ownerOf(SANDBOX_PATH, olderThanTheRunner, [runner()], NOW), "none");
});

test("with nothing running at all, every sandbox is an orphan", () => {
  assert.equal(ownerOf(SANDBOX_PATH, BIRTH, [], NOW), "none");
  assert.equal(ownerOf(SANDBOX_PATH, BIRTH, [proc("oled status --json")], NOW), "none");
});

test("only what nothing owns counts as reclaimable", () => {
  const entries = [
    box({ bytes: 100, owner: "argv" }),
    box({ bytes: 150, owner: "runner" }),
    box({ bytes: 200 }),
    box({ bytes: 300 }),
  ];
  assert.equal(reclaimableBytes(entries), 500);
});

test("the listing finds every sandbox under the root and ignores anything else there", async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, `${SANDBOX_PREFIX}one`));
    mkdirSync(join(root, `${SANDBOX_PREFIX}two`));
    mkdirSync(join(root, "something-else"));
    writeFileSync(join(root, `${SANDBOX_PREFIX}file`), "not a directory");

    const listed = await listSandboxes(root, [], NOW);
    assert.ok(listed.ok);
    assert.deepEqual(
      listed.value.map((entry) => entry.name).toSorted(),
      [`${SANDBOX_PREFIX}one`, `${SANDBOX_PREFIX}two`],
    );
  });
});

test("a sandbox a live command names is listed as in use, so cleanup never offers it", async () => {
  await withRoot(async (root) => {
    const busy = join(root, `${SANDBOX_PREFIX}busy`);
    mkdirSync(busy);
    mkdirSync(join(root, `${SANDBOX_PREFIX}idle`));

    const listed = await listSandboxes(root, [proc(`oled status --db ${busy}/db.sqlite`)], NOW);
    assert.ok(listed.ok);
    const byName = new Map(listed.value.map((entry) => [entry.name, entry.owner]));
    assert.equal(byName.get(`${SANDBOX_PREFIX}busy`), "argv");
    assert.equal(byName.get(`${SANDBOX_PREFIX}idle`), "none");
  });
});

test("a root that cannot be read is an error rather than an empty inventory", async () => {
  const listed = await listSandboxes(join(tmpdir(), "no-such-root-here"), [], NOW);
  assert.equal(listed.ok, false);
});

test("removing a sandbox takes the whole tree with it", async () => {
  await withRoot((root) => {
    const path = join(root, `${SANDBOX_PREFIX}gone`);
    mkdirSync(join(path, "npm", "deep"), { recursive: true });
    writeFileSync(join(path, "npm", "deep", "file.txt"), "x");

    const removed = removeSandbox(root, path);
    assert.ok(removed.ok);
    assert.equal(existsSync(path), false);
  });
});

test("an rm is refused for anything outside the root, however it is spelled", async () => {
  await withRoot((root) => {
    for (const path of [
      "/etc",
      join(root, "..", "elsewhere"),
      join(root, `${SANDBOX_PREFIX}a`, "..", "..", "escaped"),
    ]) {
      const removed = removeSandbox(root, path);
      assert.equal(removed.ok, false, `${path} should not be removable`);
    }
  });
});

test("an rm is refused for a directory that is not one of ours, even directly under the root", async () => {
  await withRoot((root) => {
    const path = join(root, "someone-elses-work");
    mkdirSync(path);
    const removed = removeSandbox(root, path);
    assert.equal(removed.ok, false);
    assert.equal(existsSync(path), true);
  });
});

test("an rm is refused for a path nested inside a sandbox, so only whole ones ever go", async () => {
  await withRoot((root) => {
    const path = join(root, `${SANDBOX_PREFIX}a`, "data");
    mkdirSync(path, { recursive: true });
    const removed = removeSandbox(root, path);
    assert.equal(removed.ok, false);
    assert.equal(existsSync(path), true);
  });
});
