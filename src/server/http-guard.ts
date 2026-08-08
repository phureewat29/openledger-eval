import type { Result } from "../core/result.js";

// What the dashboard checks before it will act on a request. It binds to
// loopback and there is no auth beyond that, so these two functions are the
// whole of the boundary.

export const DEFAULT_PORT = 4000;

const MAX_PORT = 65_535;

const PORT_USAGE = "usage: npm run dev [-- --port <n>]";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost"];

const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

function allowedOrigins(port: number): string[] {
  return LOOPBACK_NAMES.map((name) => `http://${name}:${port}`);
}

/**
 * A POST launches a paid run, so the request has to look like it came from the
 * tab this dashboard serves: the Host it addressed must be the loopback name
 * and port we bound, and an Origin — which a browser attaches to any cross-site
 * form post — must be that same origin. A request with no Origin at all is
 * allowed: the operator's own curl is not the threat this closes.
 */
export function isLocalRequest(host: string | undefined, origin: string | undefined, port: number): boolean {
  const allowed = LOOPBACK_NAMES.map((name) => `${name}:${port}`);
  if (host === undefined || !allowed.includes(host)) return false;
  if (origin === undefined) return true;
  return allowedOrigins(port).includes(origin);
}

/**
 * The same check, one notch stricter, for the WebSocket handshake. An upgrade
 * bypasses CORS entirely, so a page on any origin can open one and read
 * everything it pushes — which makes a *missing* Origin the exact shape of a
 * cross-site hijack rather than the curl it is on a POST. Every real browser
 * sends one on an upgrade, so requiring it costs nothing.
 */
export function isLocalUpgrade(
  host: string | undefined,
  origin: string | undefined,
  remote: string | undefined,
  port: number,
): boolean {
  if (origin === undefined) return false;
  if (remote !== undefined && !LOOPBACK_ADDRESSES.includes(remote)) return false;
  return isLocalRequest(host, origin, port);
}

export function parsePort(argv: string[]): Result<number> {
  if (argv.length === 0) return { ok: true, value: DEFAULT_PORT };

  const [flag, value] = argv;
  if (flag !== "--port" || argv.length !== 2) return { ok: false, error: PORT_USAGE };

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return { ok: false, error: `--port must be a port number, got ${value}\n${PORT_USAGE}` };
  }
  return { ok: true, value: port };
}
