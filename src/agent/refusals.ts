import type { RejectionType, ToolObservation } from "../report/events.js";

// What the host will not run, and what it says instead: every message here is
// read by the model as the answer to its own call, so each one says what to do
// differently rather than only what went wrong.

// Shell operators would let one tool call become several commands.
export const SHELL_METACHARACTERS = /[|&;<>`$]/;

export const REFUSED_SHELL =
  "refused: args cannot contain | & ; < > ` or $. Run one oled command per call and send a batch through the `stdin` field instead of a pipe.";

// Docs write placeholders as <pattern>; a model copying one verbatim needs a different correction than a pipe.
export const PLACEHOLDER = /<[a-z][a-z0-9:_-]*>/i;

export const REFUSED_PLACEHOLDER =
  "refused: args contain a <placeholder>. Replace every <...> from the docs with a real value from a previous command's output.";

/**
 * Commands whose effect lands outside the sandbox. The refusal says which
 * machine it would have touched, so the model can tell it apart from a command
 * that does not exist.
 */
export const DENIED_NOUNS: Record<string, string> = {
  open: "refused: `oled open` opens a file-manager window on the machine running this eval, which nobody is watching. Read what oled knows through its own commands instead.",
};

/** What a refusal can still name about the call it declined. */
export interface RefusedCall {
  tool: string;
  subcommand: string;
  args: string;
  command: string;
}

/** A refused call ran nothing, so it sent no stdin and has no exit code of its own. */
export function refusedObservation(
  type: RejectionType,
  call: RefusedCall,
  message: string,
): Omit<ToolObservation, "result"> {
  return {
    ...call,
    ok: false,
    exitCode: null,
    rejected: type,
    message,
    hint: null,
    stdin: false,
    stdinPreview: null,
    stdinDigest: null,
    rows: null,
    commit: null,
  };
}
