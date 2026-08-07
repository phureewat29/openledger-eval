import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tryExecute, type Result } from "../core/result.js";
import { execCapture } from "../oled/command.js";

/** Packs and `npm install --global`s a tarball so a run scores the published artifact, not the checkout's source tree. */

interface PackEntry {
  version: string;
  filename: string;
  files?: unknown[];
}

const INSTALL_TIMEOUT_MS = 300_000;

function parsePackJson(stdout: string): Result<PackEntry> {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) {
    return { ok: false, error: "npm pack --json printed no JSON array" };
  }
  const parsed = tryExecute(() => JSON.parse(stdout.slice(start, end + 1)) as PackEntry[]);
  if (!parsed.ok) return { ok: false, error: `npm pack --json was unreadable: ${parsed.error}` };

  const entry = parsed.value[0];
  if (!entry?.filename) return { ok: false, error: "npm pack --json listed no tarball" };
  return { ok: true, value: entry };
}

async function pack(repoRoot: string, destination: string): Promise<Result<PackEntry>> {
  const packed = await execCapture("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: repoRoot,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (!packed.ok) return { ok: false, error: `npm pack failed: ${packed.message}` };
  if (packed.value.exitCode !== 0) {
    return {
      ok: false,
      error: `npm pack exited ${packed.value.exitCode}: ${packed.value.stderr.trim()}`,
    };
  }
  return parsePackJson(packed.value.stdout);
}

/** dist/ is what the tarball ships: a missing build fails here instead of surfacing as a broken CLI mid-run. */
export async function packCli(
  repoRoot: string,
  destDir: string,
): Promise<Result<{ tarball: string; version: string; sha256: string }>> {
  if (!existsSync(join(repoRoot, "dist", "cli", "index.js"))) {
    return {
      ok: false,
      error: `no dist/cli/index.js in ${repoRoot}, run \`npm run build\` in the openledger checkout first`,
    };
  }

  const packed = await pack(repoRoot, destDir);
  if (!packed.ok) return packed;

  const entry = packed.value;
  const tarball = join(destDir, entry.filename);
  const bytes = tryExecute(() => readFileSync(tarball));
  if (!bytes.ok) return { ok: false, error: `cannot read ${tarball}: ${bytes.error}` };

  return {
    ok: true,
    value: {
      tarball,
      version: entry.version,
      sha256: createHash("sha256").update(bytes.value).digest("hex"),
    },
  };
}

export async function installFromTarball(
  tarball: string,
  prefix: string,
): Promise<Result<{ bin: string }>> {
  const installed = await execCapture("npm", ["install", "--global", "--prefix", prefix, tarball], {
    cwd: dirname(tarball),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (!installed.ok) return { ok: false, error: `npm install failed: ${installed.message}` };
  if (installed.value.exitCode !== 0) {
    return {
      ok: false,
      error: `npm install exited ${installed.value.exitCode}: ${installed.value.stderr.trim()}`,
    };
  }

  const bin = join(prefix, "bin", "oled");
  if (!existsSync(bin)) return { ok: false, error: `no oled binary at ${bin}` };
  return { ok: true, value: { bin } };
}
