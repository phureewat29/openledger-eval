import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tryExecute, type Result } from "../core/result.js";
import { parseFeedLine, type FeedLine } from "../shared/feed.js";

// feed.ndjson is appended to and never rewritten, so a reader that remembers how
// far it has read never has to look at the same byte twice.

export interface FeedRead {
  lines: FeedLine[];
  /** How far into the file this reader has got, which the payload carries so a client can place its lines. */
  offset: number;
  /**
   * A file that shrank was truncated or replaced, which for an append-only log
   * means it is not the file we were reading. Starting over is the only honest
   * answer, and the caller is told so it can replace rather than append.
   */
  reset: boolean;
}

/** Holds the byte offset and the partial line the last read stopped inside. */
export interface FeedTail {
  read(path: string): Result<FeedRead>;
}

export function createFeedTail(): FeedTail {
  let offset = 0;
  let carry = "";
  // Kept across reads: a multi-byte character can be split across the boundary,
  // and decoding each chunk on its own would turn it into replacement bytes.
  let decoder = new StringDecoder("utf8");

  function restart(): void {
    offset = 0;
    carry = "";
    decoder = new StringDecoder("utf8");
  }

  return {
    read(path) {
      const opened = tryExecute(() => openSync(path, "r"));
      // No file yet is the ordinary state before a run writes its first line.
      if (!opened.ok) return { ok: true, value: { lines: [], offset, reset: false } };

      const fd = opened.value;
      try {
        const size = tryExecute(() => fstatSync(fd).size);
        if (!size.ok) return { ok: false, error: `cannot measure ${path}: ${size.error}` };

        const reset = size.value < offset;
        if (reset) restart();
        if (size.value === offset) return { ok: true, value: { lines: [], offset, reset } };

        const length = size.value - offset;
        const buffer = Buffer.allocUnsafe(length);
        const read = tryExecute(() => readSync(fd, buffer, 0, length, offset));
        if (!read.ok) return { ok: false, error: `cannot read ${path}: ${read.error}` };

        offset += read.value;
        const text = carry + decoder.write(buffer.subarray(0, read.value));
        const parts = text.split("\n");
        // The last part is whatever came after the final newline: either nothing,
        // or a line the writer has not finished appending. Held back either way.
        carry = parts.pop() ?? "";

        // A line in a shape this does not know is dropped, never guessed at.
        const lines = parts.map((part) => parseFeedLine(part)).filter((line) => line !== null);
        return { ok: true, value: { lines, offset, reset } };
      } finally {
        closeSync(fd);
      }
    },
  };
}
