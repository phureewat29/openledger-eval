import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenLedgerRunner } from "../oled/command.js";
import { createSubmitAnswerTool, createTools, findTool } from "./tools.js";

/** Answers every call the same way, so a test reads only what the tool made of the call. */
function fakeRunner(stdout = ""): OpenLedgerRunner {
  return {
    async run(argv) {
      return { ok: true, value: { argv, exitCode: 0, stdout, stderr: "" } };
    },
  };
}

function oledTool(runner: OpenLedgerRunner = fakeRunner()) {
  const tool = findTool(createTools(runner), "oled");
  assert.ok(tool);
  return tool;
}

function ndjson(rows: number): string {
  return Array.from({ length: rows }, (_unused, index) => JSON.stringify({ amount: index })).join("\n");
}

test("records what was piped to a command, beside the flag that says a payload was", async () => {
  const rows = ndjson(3);
  const result = await oledTool().invoke(JSON.stringify({ args: "ingest commit", stdin: rows }));

  assert.equal(result.observation.stdin, true);
  assert.equal(result.observation.stdinPreview, rows);
  assert.equal(result.observation.rows, 3);
});

test("records no preview for a call that piped nothing", async () => {
  const result = await oledTool().invoke(JSON.stringify({ args: "status" }));
  assert.equal(result.observation.stdin, false);
  assert.equal(result.observation.stdinPreview, null);
});

test("caps a preview, and the flag still says a payload was piped", async () => {
  const rows = ndjson(4_000);
  const result = await oledTool().invoke(JSON.stringify({ args: "ingest commit", stdin: rows }));

  const preview = result.observation.stdinPreview ?? "";
  assert.ok(rows.length > 8_000, "the fixture has to be longer than the cap to test it");
  assert.ok(preview.length < rows.length, "a whole commit batch is never echoed into the record");
  assert.ok(preview.startsWith('{"amount":0}'), "the first rows are what shows the shape");
  assert.match(preview, /truncated \d+ characters/);
  assert.equal(result.observation.stdin, true, "truncating the preview does not unsay that rows were piped");
});

/**
 * The report counts repeated commands by argv and this digest together, and argv is
 * identical for every commit. Taking the digest over the capped preview would read
 * two batches that differ only past the cap as the same payload.
 */
test("the payload digest is over the whole batch, past where the preview stops", async () => {
  const head = ndjson(4_000);
  const digestOf = async (stdin: string) =>
    (await oledTool().invoke(JSON.stringify({ args: "ingest commit", stdin }))).observation
      .stdinDigest;

  const first = await digestOf(`${head}\n${JSON.stringify({ amount: 1 })}`);
  const second = await digestOf(`${head}\n${JSON.stringify({ amount: 2 })}`);
  assert.ok(first, "a piped batch has a digest");
  assert.notEqual(first, second);
  assert.equal(await digestOf(head), await digestOf(head));
  assert.equal((await oledTool().invoke(JSON.stringify({ args: "status" }))).observation.stdinDigest, null);
});

test("a refused call and an in-process tool both record no preview", async () => {
  const refused = await oledTool().invoke(JSON.stringify({ args: "ingest commit | tee rows", stdin: "{}" }));
  assert.equal(refused.observation.rejected, "refused_shell");
  assert.equal(refused.observation.stdin, false, "nothing ran, so nothing was piped");
  assert.equal(refused.observation.stdinPreview, null);

  const sink = { submitted: null };
  const submitted = await createSubmitAnswerTool(sink).invoke(JSON.stringify({ answer: "42" }));
  assert.equal(submitted.observation.stdinPreview, null);
});

test("arguments cut off mid-JSON refuse as bad_tool_args and quote what was sent", async () => {
  const truncated =
    '{"args":"ingest commit --file x --input -","stdin":"{\\"date\\":\\"2026-05-12\\",\\"deb';
  const result = await oledTool().invoke(truncated);
  assert.equal(result.observation.rejected, "bad_tool_args");
  assert.match(result.observation.message ?? "", /not valid JSON/);
  assert.match(result.observation.message ?? "", /ingest commit --file x/);
});

/**
 * The description used to ask only for "a one-line summary in `answer`", which
 * is what a model obligingly wrote for a question wanting a bare merchant name
 * — and the exact-match scorer then failed it. The dual role of `answer` has to
 * stay stated here, where the model actually reads it.
 */
test("the submit tool says when `answer` must be the bare name and nothing else", () => {
  const submit = createSubmitAnswerTool({ submitted: null });
  assert.match(submit.description, /no sentence around it/);
  assert.match(submit.description, /`value`/);
  assert.match(submit.description, /`per_currency`/);
});
