import { difference } from "es-toolkit";
import type { Result } from "../core/result.js";
import { HOST_APPENDED_FLAGS } from "../oled/contract.js";

// The model sends one string and oled is spawned with an argv, never through a
// shell, so the quoting read here is all the grouping a call gets.

// oled dispatches on at most `noun verb`.
const MAX_SUBCOMMAND_WORDS = 2;

export function tokenize(input: string): Result<string[]> {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) return { ok: false, error: "unterminated quote in args" };
  if (started) tokens.push(current);
  if (tokens.length === 0) return { ok: false, error: "args was empty" };
  return { ok: true, value: tokens };
}

/** Tolerates a leading `oled` and guarantees --json, so NDJSON is never optional. */
export function normalizeArgv(tokens: string[]): string[] {
  const argv = tokens[0] === "oled" ? tokens.slice(1) : tokens;
  return [...argv, ...difference(HOST_APPENDED_FLAGS, argv)];
}

export function subcommandOf(argv: string[], fallback: string): string {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-") || words.length === MAX_SUBCOMMAND_WORDS) break;
    words.push(token);
  }
  return words.join(" ") || fallback;
}

/** The noun oled dispatches on, before any flag or its value can be mistaken for one. */
export function nounOf(argv: string[]): string {
  return argv.find((token) => !token.startsWith("-")) ?? "";
}
