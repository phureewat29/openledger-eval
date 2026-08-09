import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebSocketServer, type WebSocket } from "ws";
import * as z from "zod";
import { readModelIds, SUITE_IDS } from "../config.js";
import { finalizeDoc, isRunningFresh, writeLive } from "../report/live.js";
import { parseClientMessage, type ServerMessage } from "../shared/protocol.js";
import { createRegistry, type Client } from "./channels.js";
import { digestOf } from "./digest.js";
import { isLocalRequest, isLocalUpgrade, parsePort } from "./http-guard.js";
import { launcher, parseLaunchRequest, parseRerunRequest } from "./launch.js";
import { listProcesses, processExists } from "./procs.js";
import {
  findIteration,
  listIterations,
  listRunRecords,
  newestLive,
  readBenchmark,
  readLive,
  readFeedTail,
  readRunRecord,
} from "./reports-fs.js";
import { isOrphan, listSandboxes, removeSandbox, sandboxRoot } from "./sandboxes.js";
import { createSources } from "./watch.js";

// The dashboard's one process: a JSON API for what does not move, a websocket
// for what does, and the built page. It reads the reports tree and owns the
// launch slot; it never writes a report.

const HOST = "127.0.0.1";

const REPORTS_ROOT = new URL("../../reports/", import.meta.url).pathname;

const MAX_BODY = 64 * 1_024;

const FEED_LINES = 200;

const SERVER_ID = randomUUID();

const port = ((): number => {
  const parsed = parsePort(process.argv.slice(2));
  if (parsed.ok) return parsed.value;
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
})();

const deps = { reportsRoot: REPORTS_ROOT, launcher, now: () => new Date() };
const registry = createRegistry(createSources(deps));

const app = new Hono();

/**
 * Every POST either spends OpenRouter credit or deletes files, so each one has
 * to look like it came from the tab this dashboard serves. GETs are unguarded:
 * the bind is loopback and reading is not the threat.
 */
app.use("/api/*", bodyLimit({ maxSize: MAX_BODY }), async (c, next) => {
  if (c.req.method !== "POST") return next();
  const local = isLocalRequest(c.req.header("host"), c.req.header("origin"), port);
  if (!local) return c.json({ error: "a launch has to come from this dashboard's own page" }, 403);
  return next();
});

const LAUNCH_BODY = z.object({ suites: z.array(z.string()), models: z.array(z.string()) });

/** `cases` omitted is the whole suite for that model; parseRerunRequest whitelists every field. */
const RERUN_BODY = z.object({
  model: z.string(),
  suite: z.string(),
  cases: z.array(z.string()).optional(),
});

const CLEANUP_BODY = z.object({ names: z.array(z.string()).min(1) });

app.get("/api/bootstrap", (c) => {
  const iterations = listIterations(REPORTS_ROOT);
  const models = readModelIds();
  return c.json({
    serverId: SERVER_ID,
    port,
    suites: SUITE_IDS,
    models: models.ok ? models.value : [],
    iterations: iterations.ok ? iterations.value : [],
  });
});

app.get("/api/iterations", (c) => {
  const iterations = listIterations(REPORTS_ROOT);
  if (!iterations.ok) return c.json({ error: iterations.error }, 500);

  // Each one is digested here rather than on the page: the figures come from
  // benchmark.json and live.json, and a browser has no business reading either.
  const now = new Date();
  return c.json({ iterations: iterations.value.map((summary) => digestOf(REPORTS_ROOT, summary, now)) });
});

app.get("/api/iterations/:slug", (c) => {
  const slug = c.req.param("slug");
  const found = findIteration(REPORTS_ROOT, slug);
  if (!found.ok) return c.json({ error: found.error }, 500);
  if (found.value === null) return c.json({ error: `no iteration ${slug}` }, 404);

  const benchmark = found.value.hasBenchmark ? readBenchmark(REPORTS_ROOT, slug) : null;
  const runs = listRunRecords(REPORTS_ROOT, slug);
  const feed = readFeedTail(REPORTS_ROOT, slug, FEED_LINES);
  return c.json({
    summary: found.value,
    benchmark: benchmark?.ok === true ? benchmark.value : null,
    runs: runs.ok ? runs.value : [],
    feed: feed.ok ? feed.value : [],
  });
});

app.get("/api/iterations/:slug/runs/:model/:suite/:stem", (c) => {
  const { slug, model, suite, stem } = c.req.param();
  const record = readRunRecord(REPORTS_ROOT, slug, model, suite, stem);
  if (!record.ok) return c.json({ error: record.error }, 404);
  return c.json({ record: record.value });
});

app.post("/api/launch", async (c) => {
  const body = LAUNCH_BODY.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "a launch needs suites and models" }, 422);

  const models = readModelIds();
  if (!models.ok) return c.json({ error: models.error }, 500);

  const form = new URLSearchParams();
  for (const suite of body.data.suites) form.append("suite", suite);
  for (const model of body.data.models) form.append("model", model);

  const request = parseLaunchRequest(form, models.value);
  if (!request.ok) return c.json({ error: request.error }, 422);

  const snapshot = newestLive(REPORTS_ROOT);
  const outcome = launcher.launch(request.value, snapshot.ok ? snapshot.value : null, new Date());
  if (!outcome.ok) return c.json({ error: outcome.message }, outcome.reason === "busy" ? 409 : 500);
  return c.json({ ok: true });
});

/**
 * Rerunning one cell, or one model's suite, into the report it came from. The
 * scope arrives as a model, a suite and a list of cases; an empty list is the
 * whole suite, which is what the grid's row offers.
 */
app.post("/api/iterations/:slug/rerun", async (c) => {
  const slug = c.req.param("slug");
  const body = RERUN_BODY.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "a rerun needs a model and a suite" }, 422);

  const found = findIteration(REPORTS_ROOT, slug);
  if (!found.ok) return c.json({ error: found.error }, 500);
  if (found.value === null) return c.json({ error: `no iteration ${slug}` }, 404);

  const benchmark = readBenchmark(REPORTS_ROOT, slug);
  if (!benchmark.ok) {
    return c.json({ error: `${slug} has no benchmark to merge into: ${benchmark.error}` }, 409);
  }

  const models = readModelIds();
  if (!models.ok) return c.json({ error: models.error }, 500);

  const request = parseRerunRequest(slug, body.data, models.value);
  if (!request.ok) return c.json({ error: request.error }, 422);

  const snapshot = newestLive(REPORTS_ROOT);
  const outcome = launcher.rerun(request.value, snapshot.ok ? snapshot.value : null, new Date());
  if (!outcome.ok) return c.json({ error: outcome.message }, outcome.reason === "busy" ? 409 : 500);
  return c.json({ ok: true });
});

app.post("/api/stop", (c) => {
  const snapshot = newestLive(REPORTS_ROOT);
  const outcome = launcher.stop(snapshot.ok ? snapshot.value : null, new Date());
  if (!outcome.ok) return c.json({ error: outcome.message }, outcome.reason === "idle" ? 409 : 500);
  return c.json({ ok: true });
});

/**
 * Freezing a run and letting it go again. Both are one signal to the whole
 * process group, and which one is on offer is read from the OS rather than
 * remembered — so a run frozen by a dashboard that has since restarted is still
 * found, and still resumable.
 */
app.post("/api/run/:action{pause|resume}", (c) => {
  const action = c.req.param("action") === "pause" ? "pause" : "resume";
  const snapshot = newestLive(REPORTS_ROOT);
  const outcome = launcher.hold(action, snapshot.ok ? snapshot.value : null, new Date());
  if (!outcome.ok) return c.json({ error: outcome.message }, outcome.reason === "idle" ? 409 : 500);
  return c.json({ ok: true });
});

/**
 * A run killed outright leaves no marker: live.json still says "running" with a
 * frozen heartbeat, and `busyReason` refuses every later launch on the strength
 * of it. Finalising by hand is the way out, and it is refused while the run
 * could still be alive so it can never be used to disown a working matrix.
 */
app.post("/api/iterations/:slug/finish", (c) => {
  const slug = c.req.param("slug");
  const doc = readLive(REPORTS_ROOT, slug);
  if (!doc.ok) return c.json({ error: doc.error }, 404);
  if (doc.value.status === "done") return c.json({ ok: true, already: true });

  const now = new Date();
  if (isRunningFresh(doc.value, now)) {
    return c.json({ error: `${slug} is still beating; stop it rather than marking it finished` }, 409);
  }
  const pid = doc.value.pid;
  if (pid !== undefined && processExists(pid)) {
    return c.json({ error: `pid ${pid} is still alive; stop the run rather than marking it finished` }, 409);
  }

  const written = writeLive(join(REPORTS_ROOT, slug), finalizeDoc(doc.value));
  if (!written.ok) return c.json({ error: written.error }, 500);
  return c.json({ ok: true, already: false });
});

app.post("/api/sandboxes/cleanup", async (c) => {
  const body = CLEANUP_BODY.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "name the sandboxes to remove" }, 422);

  // The orphan set is re-derived here and the client's list is only ever
  // filtered against it: a name that is in use, or that no longer exists, is
  // refused however confidently it was asked for.
  const root = sandboxRoot();
  const procs = await listProcesses();
  const listed = await listSandboxes(root, procs.ok ? procs.value : [], new Date());
  if (!listed.ok) return c.json({ error: listed.error }, 500);

  const orphans = new Map(listed.value.filter(isOrphan).map((entry) => [entry.name, entry.path]));
  const removed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const name of body.data.names) {
    const path = orphans.get(name);
    if (path === undefined) {
      failed.push({ name, error: "not an orphaned sandbox" });
      continue;
    }
    const gone = removeSandbox(root, path);
    if (gone.ok) removed.push(name);
    else failed.push({ name, error: gone.error });
  }
  return c.json({ removed, failed });
});

/**
 * In development the page is Vite's to serve — it holds the module graph the
 * browser is asking for — and this process answers only `/api` and `/ws`, which
 * Vite proxies here. Mounting a static handler over a `dist/` that does not
 * exist would log a warning on every boot and answer nothing.
 */
const DIST = new URL("../../dist/", import.meta.url).pathname;
const built = existsSync(join(DIST, "index.html"));

if (built) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("/*", serveStatic({ path: "./dist/index.html" }));
} else {
  app.get("/*", (c) =>
    c.text(
      "openledger-eval: the dashboard API is up, but no page has been built.\n\n" +
        "  npm run dev    the page is served by Vite; open the URL it prints\n" +
        "  npm start      builds the page and serves it from here\n",
      503,
    ),
  );
}

const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
  const where = built ? `http://${HOST}:${info.port}` : `http://${HOST}:${info.port} (api only — the page is Vite's)`;
  // A console line is a machine surface, so the package name rather than the brand.
  process.stdout.write(`openledger-eval dashboard listening on ${where}\n`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  const reason =
    error.code === "EADDRINUSE"
      ? `port ${port} is already in use; pass --port <n> to pick another`
      : error.message;
  process.stderr.write(`${reason}\n`);
  process.exit(1);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1_024 });

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

wss.on("connection", (socket) => {
  const client: Client = { id: randomUUID(), send: (message) => send(socket, message) };
  send(socket, { type: "welcome", serverId: SERVER_ID });

  socket.on("message", (raw) => {
    const message = parseClientMessage(raw.toString());
    if (message === null) {
      send(socket, { type: "error", channel: null, error: "unreadable message" });
      return;
    }
    if (message.cmd === "unsubscribe") return registry.unsubscribe(client, message.channel);
    registry.subscribe(client, message.channel);
  });

  socket.on("close", () => registry.remove(client));
  socket.on("error", () => registry.remove(client));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const allowed =
    url.pathname === "/ws" &&
    isLocalUpgrade(req.headers.host, req.headers.origin, req.socket.remoteAddress, port);
  if (!allowed) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

process.on("exit", () => registry.stopAll());

