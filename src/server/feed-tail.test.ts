import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFeedTail } from "./feed-tail.js";

function line(text: string): string {
  return `${JSON.stringify({ at: "2026-08-08T05:00:00.000Z", scope: "eval", kind: "note", text })}\n`;
}

function withFile(body: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "feed-tail-test-"));
  try {
    body(join(dir, "feed.ndjson"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing file is an empty read, not an error: a run writes its first line late", () => {
  const tail = createFeedTail();
  const read = tail.read(join(tmpdir(), "no-such-feed.ndjson"));
  assert.ok(read.ok);
  assert.deepEqual(read.value.lines, []);
});

test("reads what is there, then only what arrives after it", () => {
  withFile((path) => {
    writeFileSync(path, line("one") + line("two"));
    const tail = createFeedTail();

    const first = tail.read(path);
    assert.ok(first.ok);
    assert.deepEqual(
      first.value.lines.map((entry) => entry.text),
      ["one", "two"],
    );

    // Nothing appended: the same bytes are never read twice.
    const idle = tail.read(path);
    assert.ok(idle.ok);
    assert.deepEqual(idle.value.lines, []);

    appendFileSync(path, line("three"));
    const next = tail.read(path);
    assert.ok(next.ok);
    assert.deepEqual(
      next.value.lines.map((entry) => entry.text),
      ["three"],
    );
  });
});

test("a line still being written is held back, then delivered once it is whole", () => {
  withFile((path) => {
    const whole = line("complete");
    // What a reader sees when it lands between the write and its newline.
    writeFileSync(path, whole + '{"at":"2026-08-08T05:00:00.000Z","scope":"ev');
    const tail = createFeedTail();

    const first = tail.read(path);
    assert.ok(first.ok);
    assert.deepEqual(
      first.value.lines.map((entry) => entry.text),
      ["complete"],
      "the half-written line is not guessed at",
    );

    appendFileSync(path, 'al","kind":"note","text":"finished"}\n');
    const second = tail.read(path);
    assert.ok(second.ok);
    assert.deepEqual(
      second.value.lines.map((entry) => entry.text),
      ["finished"],
      "the held-back fragment is completed rather than dropped",
    );
  });
});

test("a multi-byte character split across two reads survives", () => {
  withFile((path) => {
    const text = line("scored 11/12 · 2m07s");
    const bytes = Buffer.from(text, "utf8");
    // Split inside the three-byte ·, which a per-chunk decode would mangle.
    const middle = bytes.indexOf(Buffer.from("·", "utf8")) + 1;

    writeFileSync(path, bytes.subarray(0, middle));
    const tail = createFeedTail();
    tail.read(path);

    appendFileSync(path, bytes.subarray(middle));
    const second = tail.read(path);
    assert.ok(second.ok);
    assert.deepEqual(
      second.value.lines.map((entry) => entry.text),
      ["scored 11/12 · 2m07s"],
    );
  });
});

test("a file that shrank is read from the start again and says so", () => {
  withFile((path) => {
    writeFileSync(path, line("old one") + line("old two"));
    const tail = createFeedTail();
    tail.read(path);

    // A new iteration's feed, or a truncation: not the file we were reading.
    writeFileSync(path, line("new"));
    const read = tail.read(path);
    assert.ok(read.ok);
    assert.equal(read.value.reset, true);
    assert.deepEqual(
      read.value.lines.map((entry) => entry.text),
      ["new"],
    );
  });
});

test("a line in a shape the reader does not know is dropped, and its neighbours kept", () => {
  withFile((path) => {
    writeFileSync(path, line("before") + "not json at all\n" + line("after"));
    const read = createFeedTail().read(path);
    assert.ok(read.ok);
    assert.deepEqual(
      read.value.lines.map((entry) => entry.text),
      ["before", "after"],
    );
  });
});

test("the offset advances to the end of what was read, so a reader can resume", () => {
  withFile((path) => {
    const text = line("one");
    writeFileSync(path, text);
    const read = createFeedTail().read(path);
    assert.ok(read.ok);
    assert.equal(read.value.offset, Buffer.byteLength(text));
  });
});
