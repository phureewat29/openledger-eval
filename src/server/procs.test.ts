import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupOf,
  inGroup,
  isSafeGroup,
  nest,
  parseElapsed,
  parsePs,
  selfProc,
  type ProcInfo,
} from "./procs.js";

/** A real `ps -Ao pid,ppid,pgid,stat,%cpu,rss,etime,command` header and body, spacing included. */
const PS_OUTPUT = [
  "  PID  PPID  PGID STAT  %CPU    RSS     ELAPSED COMM",
  "48213 48200 48213   Ss   0.1  14896       02:14 npm start -- --suite all --model deepseek/deepseek-v4-flash",
  "48219 48213 48213    S   4.2 118400       02:13 node /Users/x/openledger-eval/src/main.ts",
  "48402 48219 48213   R+  18.7  42112       00:03 oled ingest commit --file sf:abc --json",
  "  100     1   100    S   0.0  14368 01-15:41:32 /System/Library/cloudd",
].join("\n");

function proc(patch: Partial<ProcInfo> = {}): ProcInfo {
  return { pid: 1, ppid: 0, pgid: 1, state: "S", cpu: 0, rssBytes: 0, elapsedSec: 0, command: "x", ...patch };
}

test("reads every column ps was asked for, and takes the rest of the line as the command", () => {
  const procs = parsePs(PS_OUTPUT);
  assert.equal(procs.length, 4);
  const [leader] = procs;
  assert.equal(leader?.pid, 48213);
  assert.equal(leader?.ppid, 48200);
  assert.equal(leader?.pgid, 48213);
  assert.equal(leader?.state, "Ss");
  assert.equal(leader?.cpu, 0.1);
  assert.equal(leader?.command, "npm start -- --suite all --model deepseek/deepseek-v4-flash");
});

test("rss is reported in bytes, so no reader has to know ps counts kibibytes", () => {
  const [leader] = parsePs(PS_OUTPUT);
  assert.equal(leader?.rssBytes, 14_896 * 1_024);
});

test("the header and any line in an unknown shape are dropped, and their neighbours kept", () => {
  const procs = parsePs(["  PID  PPID  PGID  %CPU", "not a process line at all", PS_OUTPUT].join("\n"));
  assert.equal(procs.length, 4);
});

test("elapsed time is read in all four widths ps writes it in", () => {
  assert.equal(parseElapsed("03"), 3);
  assert.equal(parseElapsed("02:14"), 134);
  assert.equal(parseElapsed("01:02:14"), 3_734);
  assert.equal(parseElapsed("01-15:41:32"), 86_400 + 56_492);
});

test("a duration ps wrote in no shape this knows counts as no time rather than NaN", () => {
  assert.equal(parseElapsed("who knows"), 0);
  assert.equal(parseElapsed(""), 0);
});

test("a pid names its group, which is how a run started at a terminal is adopted", () => {
  const procs = parsePs(PS_OUTPUT);
  // live.json records the runner, never the npm above it; its pgid names the job.
  assert.equal(groupOf(procs, 48219), 48213);
  assert.equal(groupOf(procs, 999_999), null);
});

test("a group holds every process of one run and nothing from another", () => {
  const procs = parsePs(PS_OUTPUT);
  const group = inGroup(procs, 48213);
  assert.deepEqual(
    group.map((entry) => entry.pid),
    [48213, 48219, 48402],
  );
});

test("nesting hangs each process under its parent, deepest branch included", () => {
  const roots = nest(inGroup(parsePs(PS_OUTPUT), 48213));
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.pid, 48213);
  assert.equal(roots[0]?.children[0]?.pid, 48219);
  assert.equal(roots[0]?.children[0]?.children[0]?.pid, 48402);
});

test("a process whose parent is outside the group is a root, so an orphan is never hidden", () => {
  // What reparenting to launchd leaves behind: the ppid names nothing in the set.
  const roots = nest([proc({ pid: 500, ppid: 1, pgid: 500 }), proc({ pid: 501, ppid: 500, pgid: 500 })]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.pid, 500);
});

test("a process that somehow parents itself is a root rather than an endless tree", () => {
  const roots = nest([proc({ pid: 7, ppid: 7 })]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.children.length, 0);
});

/** The dashboard itself, in a group of its own, as every safety check reads it. */
const SELF = proc({ pid: 900, pgid: 900, command: "node src/server/app.ts" });

const RUNNER = proc({ pid: 101, pgid: 100, command: "node /x/openledger-eval/src/main.ts" });

test("a group holding the eval runner and led by npm is safe to signal whole", () => {
  const members = [proc({ pid: 100, pgid: 100, command: "npm start -- --suite all" }), RUNNER];
  assert.equal(isSafeGroup(100, members, SELF).ok, true);
});

test("this dashboard's own group is never signalled, by pid or by group", () => {
  assert.equal(isSafeGroup(900, [SELF, RUNNER], SELF).ok, false);
  assert.equal(isSafeGroup(900, [SELF, RUNNER], proc({ pid: 901, pgid: 900 })).ok, false);
});

test("a group this dashboard is a member of is refused, whoever leads it", () => {
  const members = [proc({ pid: 100, pgid: 100, command: "npm start" }), RUNNER, { ...SELF, pgid: 100 }];
  assert.equal(isSafeGroup(100, members, SELF).ok, false);
});

test("a group led by a shell is refused, because it holds more than the run", () => {
  // No job control — a script's `sh -c` shares its group, and signalling it
  // would reach whatever else the operator has in there.
  for (const shell of ["/bin/sh", "-zsh", "bash", "/usr/local/bin/fish"]) {
    const members = [proc({ pid: 100, pgid: 100, command: `${shell} -c 'npm start'` }), RUNNER];
    assert.equal(isSafeGroup(100, members, SELF).ok, false, `${shell} should not be signalled as a group`);
  }
});

test("a group with no eval runner in it is refused, whatever else it holds", () => {
  const members = [proc({ pid: 100, pgid: 100, command: "npm run something-else" })];
  assert.equal(isSafeGroup(100, members, SELF).ok, false);
});

test("the init group is never a target", () => {
  assert.equal(isSafeGroup(1, [RUNNER], SELF).ok, false);
  assert.equal(isSafeGroup(0, [RUNNER], SELF).ok, false);
});

test("this process is found in a snapshot, so a group can be checked against it", () => {
  const procs = [proc({ pid: process.pid, pgid: 42, command: "node --test" }), RUNNER];
  assert.equal(selfProc(procs)?.pgid, 42);
  assert.equal(selfProc([RUNNER]), null);
});
