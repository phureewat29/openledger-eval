import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { LiveDoc, LiveItem } from "../../report/live.js";
import type { LivePayload } from "../../shared/payloads.js";
import { Badge, Callout, Panel } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { ActivityDrawer } from "../components/feed/ActivityDrawer.js";
import { Legend } from "../components/grid/Legend.js";
import { SuiteGrid } from "../components/grid/SuiteGrid.js";
import { RerunDialog, type RerunScope } from "../components/RerunDialog.js";
import { RunSheet } from "../components/run/RunSheet.js";
import { modelSlug } from "../../shared/vocabulary.js";
import { duration } from "../lib/format.js";

// The screen a run is watched on. The bar above it carries the vitals, so this
// owns the matrix itself, what the state means when it is not simply running,
// and the feed underneath.

/** Where a failed launch left its reasons, named here so the panel points somewhere. */
const LAUNCH_LOG = "reports/dashboard-launch.log";


/**
 * How long a run has been silent. The live payload stops arriving once it goes
 * stale — the server publishes on change, and a dead run changes nothing — so
 * the page has to keep this clock itself or the figure freezes at whatever it
 * said the moment the run died.
 */
function useSilence(updatedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (updatedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [updatedAt]);

  return updatedAt === null ? 0 : Math.max(0, now - Date.parse(updatedAt));
}

/**
 * What this run is, in the terms a result gets filed under later. Each figure
 * wears its own label rather than being strung together on middots: a reader
 * looking for the skill version should not have to count separators to find
 * which of four version numbers it is.
 */
function Identity({ slug, doc }: { slug: string | null; doc: LiveDoc }) {
  const { identity, config } = doc;
  // Labels are words and get a capital; `oled` keeps its own case because it is
  // the CLI's name rather than a description of one, the way `npm` is.
  const facts: [string, string][] = [
    ["Report", `reports/${slug ?? "—"}`],
    ["oled", identity.oledVersion],
    ["SKILL.md", identity.skillVersion],
    ["Eval", identity.evalVersion],
    ["Runs", String(doc.items.length)],
    ["Concurrency", String(config.concurrency)],
  ];

  return (
    <Panel>
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-3.5 py-2.5">
        {facts.map(([label, value]) => (
          <span key={label} className="flex items-baseline gap-1.5">
            <span className="text-subtle">{label}</span>
            <span className="tnum text-muted">{value}</span>
          </span>
        ))}
      </div>
      {/* What the marks below mean, beside the run they describe. */}
      <div className="border-t border-line px-3.5 py-2.5">
        <Legend />
      </div>
    </Panel>
  );
}

/**
 * One layout for every state the screen can be in, so the feed sits in the same
 * place whether there is a grid above it or a stack trace.
 *
 * The drawer is a fixed floor and the region above it is what scrolls. It was a
 * sticky element in the scrolling flow before, which left a gap: with short
 * content the region above grew to fill the screen and the drawer was laid out
 * below that, so there was always exactly a drawer's worth of empty ground to
 * scroll through past the end.
 *
 * A scroll pane here used to be impossible — it would clip the grid's hover
 * cards — but those are drawn through a portal now and no longer care.
 */
function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">{children}</div>
      <ActivityDrawer />
    </div>
  );
}

export function Live() {
  const live = useOutletContext<LivePayload | null>();
  const [, setParams] = useSearchParams();
  const [rerunning, setRerunning] = useState<RerunScope | null>(null);

  // Which cell, and nothing more: another screen owns what opening one looks
  // like. Pushed rather than replaced so the browser's back button closes it.
  const onOpen = useCallback(
    (item: LiveItem) => {
      setParams((held) => {
        const next = new URLSearchParams(held);
        next.set("model", modelSlug(item.model));
        next.set("suite", item.suite);
        next.set("case", item.caseId);
        return next;
      });
    },
    [setParams],
  );

  const silence = useSilence(live?.kind === "running-stale" ? (live.doc?.updatedAt ?? null) : null);

  if (live === null) return <Empty title="connecting" hint="waiting for the dashboard" />;

  // Nothing has ever been launched, so there is no feed under it either.
  if (live.kind === "none") {
    return <Empty title="no runs yet" hint="launch one from the rail and this fills in" />;
  }

  if (live.kind === "starting") {
    return (
      <Screen>
        <Empty
          title="starting"
          hint="packing a workspace — the grid appears once the runner has planned the matrix"
        />
      </Screen>
    );
  }

  if (live.kind === "failed") {
    const { exit, tail } = live.slot;
    return (
      <Screen>
        <div className="space-y-3 p-5">
          <Callout tone="bad">
            <Badge tone="bad">launch failed</Badge>{" "}
            <span className="text-muted">
              {exit === null ? "the runner never started" : `exit ${exit.code ?? "no code"}`}
            </span>
          </Callout>
          <p className="text-subtle">the last of {LAUNCH_LOG}</p>
          <pre className="tnum overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface p-3 text-muted">
            {tail === "" ? "the launch log is empty" : tail}
          </pre>
        </div>
      </Screen>
    );
  }

  // Every state past here is one the runner reached, so it has a document; a
  // null one is a report directory that was cleared out from under the page.
  const doc = live.doc;
  if (doc === null) return <Empty title="nothing to show" hint="this run wrote no live.json" />;

  const suites = [...new Set(doc.items.map((item) => item.suite))];
  const frozen = doc.items.filter((item) => item.state === "running").length;
  // Only once this run is over. The launch slot refuses a rerun while anything is
  // in flight, so offering the button mid-matrix would be offering a refusal.
  const slug = live.slug;
  const rerunnable = live.kind === "done" && slug !== null;

  return (
    <Screen>
      <div className="space-y-6 p-5">
        <div className="space-y-1">
          {live.kind === "running-paused" && (
            <Callout tone="warn">
              <Badge tone="warn">paused</Badge>{" "}
              <span className="text-muted">
                frozen where it stood
                {frozen > 0 && `, ${frozen} ${frozen === 1 ? "run" : "runs"} held mid-request`} — resume it
                from the bar above
              </span>
            </Callout>
          )}
          {live.kind === "running-stale" && (
            <Callout tone="warn">
              <Badge tone="warn">no heartbeat</Badge>{" "}
              <span className="text-muted">
                silent for {duration(silence)} — this is the last thing the run wrote
              </span>
            </Callout>
          )}
          {live.kind === "done" && !live.hasBenchmark && (
            <Callout tone="warn">
              <Badge tone="warn">not scored</Badge>{" "}
              <span className="text-muted">
                no benchmark was written — the run stopped before it could score itself
              </span>
            </Callout>
          )}
          <Identity slug={live.slug} doc={doc} />
        </div>

        {suites.map((suite) => (
          <SuiteGrid
            key={suite}
            suite={suite}
            items={doc.items.filter((item) => item.suite === suite)}
            onOpen={onOpen}
            onRerun={rerunnable ? (model, cases) => setRerunning({ slug, model, suite, cases }) : undefined}
          />
        ))}
      </div>

      {/* The live route carries no :slug, so the sheet is told which iteration
          the grid it opened from belongs to. */}
      <RunSheet slug={live.slug ?? undefined} onRerun={rerunnable ? setRerunning : undefined} />
      <RerunDialog scope={rerunning} onClose={() => setRerunning(null)} />
    </Screen>
  );
}
