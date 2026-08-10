// A write that fails once and keeps failing must not spam stderr on every
// retry after — and must never look like a reason to kill a paid run, so the
// caller keeps retrying regardless of what this reports.

/** Writes `message` to stderr the first time it is called, and stays quiet after. */
export function warnOnce(): (message: string) => void {
  let warned = false;
  return (message) => {
    if (warned) return;
    warned = true;
    process.stderr.write(`${message}\n`);
  };
}
