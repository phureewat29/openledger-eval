import { uniq } from "es-toolkit";
import { type ReactNode, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { LiveDoc } from "../../report/live.js";
import { duration } from "../../shared/format.js";
import { LAUNCH_LOG } from "../../shared/paths.js";
import type { LivePayload } from "../../shared/payloads.js";
import { RUN_STATE_LEGEND } from "../../shared/vocabulary.js";
import { Badge, Callout, Panel } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { ActivityDrawer } from "../components/feed/ActivityDrawer.js";
import { Legend } from "../components/grid/Legend.js";
import { SuiteGrid } from "../components/grid/SuiteGrid.js";
import { RerunDialog, type RerunScope } from "../components/RerunDialog.js";
import { RunSheet } from "../components/run/RunSheet.js";
import { inFlight, plural } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { identityRows, type IdentityRow } from "../lib/identity.js";
import { useRunSheet } from "../lib/run-sheet.js";

// The screen a run is watched on. The bar above it carries the vitals, so this
// owns the matrix itself, what the state means when it is not simply running,
// and the feed underneath.

/** The identity facts this screen has room for; the rest are the report page's. */
const LIVE_IDENTITY_FACTS = ["oled", "SKILL.md", "Eval", "Concurrency"];

/**
 * What this run is, in the terms a result gets filed under later. Each figure
 * wears its own label rather than being strung together on middots: a reader
 * looking for the skill version should not have to count separators to find
 * which of four version numbers it is.
 */
function Identity({ slug, doc }: { slug: string | null; doc: LiveDoc }) {
  const { identity, config } = doc;
  const facts: IdentityRow[] = [
    { label: "Report", value: `reports/${slug ?? "—"}` },
    { label: "Runs", value: String(doc.items.length) },
    ...identityRows(identity, config).filter((row) => LIVE_IDENTITY_FACTS.includes(row.label)),
  ];

  return (
    <Panel>
      <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-3.5 py-2.5">
        {facts.map((fact) => (
          <span key={fact.label} className="flex items-baseline gap-1.5">
            <span className="text-subtle">{fact.label}</span>
            <span className="tnum text-muted">{fact.value}</span>
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
 * The drawer is a fixed floor and the region above it is what scrolls, so short
 * content never leaves a drawer's worth of empty ground past the end.
 *
 * The grid's hover cards are drawn through a portal, so a scroll pane here
 * cannot clip them.
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
  const { open: onOpen } = useRunSheet();
  const [rerunning, setRerunning] = useState<RerunScope | null>(null);

  // The live payload stops arriving once a run goes stale — the server publishes
  // on change, and a dead run changes nothing — so this clock has to be kept
  // here or the silence figure below would freeze at whatever it last said.
  const updatedAt = live?.kind === "running-stale" ? (live.doc?.updatedAt ?? null) : null;
  const now = useNow(updatedAt !== null);
  const silence = updatedAt === null ? 0 : Math.max(0, now - Date.parse(updatedAt));

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

  const suites = uniq(doc.items.map((item) => item.suite));
  const frozen = inFlight(doc);
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
              <Badge tone="warn">{RUN_STATE_LEGEND["running-paused"].label}</Badge>{" "}
              <span className="text-muted">
                frozen where it stood
                {frozen > 0 && `, ${plural(frozen, "run")} held mid-request`} — resume it
                from the bar above
              </span>
            </Callout>
          )}
          {live.kind === "running-stale" && (
            <Callout tone="warn">
              <Badge tone="warn">{RUN_STATE_LEGEND["running-stale"].label}</Badge>{" "}
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
