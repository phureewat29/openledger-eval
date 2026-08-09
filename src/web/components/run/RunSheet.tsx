import { RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { RunRecord, TerminalState } from "../../../report/record.js";
import { countChecks } from "../../../suites/types.js";
import { get } from "../../lib/api.js";
import { duration, tokens, usd } from "../../lib/format.js";
import { Empty } from "../Empty.js";
import type { RerunScope } from "../RerunDialog.js";
import { ChecksTable } from "./ChecksTable.js";
import { Transcript } from "./Transcript.js";
import { Badge, Panel, type Tone } from "../Badge.js";

// One run, in full: opened by putting model/suite/case in the URL's search
// params so the panel is shareable and survives a refresh. `slug` names which
// iteration those three belong to — it comes from the route when this sheet
// sits under /reports/:slug, and from the `slug` prop when a caller without
// that route param (the live grid) already knows it another way.

interface RunResponse {
  record: RunRecord;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "loaded"; response: RunResponse };

const STATE_LABEL: Record<TerminalState, string> = {
  graded: "graded",
  endpoint_error: "endpoint error",
  sandbox_error: "sandbox error",
};

/** Only a failure or a harness error is loud; a clean run wears the accent. */
function verdictTone(record: RunRecord): Tone {
  if (record.state !== "graded") return "bad";
  return record.grade?.passed === false ? "warn" : "accent";
}

function verdictLabel(record: RunRecord): string {
  const base = STATE_LABEL[record.state];
  if (record.grade === null) return base;
  return `${base} · ${record.grade.passed ? "passed" : "failed"}`;
}

function RunDetail({ record }: { record: RunRecord }) {
  const counts = record.grade ? countChecks(record.grade.assertions) : null;

  return (
    <div className="p-5">
      <Panel className="px-3.5 py-3">
        <div className="tnum flex flex-wrap items-center gap-x-4 gap-y-2">
          <Badge tone={verdictTone(record)}>{verdictLabel(record)}</Badge>
          {counts && (
            <span className="text-muted">
              <span className="text-fg">{counts.passed}</span> of {counts.total} checks
            </span>
          )}
          <span className="text-muted">{duration(record.metrics.durationMs)}</span>
          <span className="text-muted">
            {tokens(record.metrics.tokensIn)} / {tokens(record.metrics.tokensOut)}
          </span>
          <span className="text-muted">{usd(record.costUsd)}</span>
        </div>
        {record.state !== "graded" && record.error !== null && (
          <p className="mt-2 break-all text-bad">{record.error}</p>
        )}
      </Panel>

      <div className="mt-4">
        <ChecksTable assertions={record.grade?.assertions ?? []} />
      </div>

      <Transcript events={record.events} />
    </div>
  );
}

export function RunSheet({
  slug: slugProp,
  onRerun,
}: { slug?: string; onRerun?: (scope: RerunScope) => void } = {}) {
  const params = useParams<{ slug?: string }>();
  const slug = slugProp ?? params.slug ?? null;

  const [searchParams, setSearchParams] = useSearchParams();
  const model = searchParams.get("model");
  const suite = searchParams.get("suite");
  const caseId = searchParams.get("case");

  const close = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("model");
      next.delete("suite");
      next.delete("case");
      return next;
    });
  }, [setSearchParams]);

  useEffect(() => {
    if (slug === null || model === null || suite === null || caseId === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, model, suite, caseId, close]);

  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (slug === null || model === null || suite === null || caseId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    void get<RunResponse>(`/api/iterations/${slug}/runs/${model}/${suite}/${caseId}`).then((result) => {
      if (cancelled) return;
      setState(result.ok ? { kind: "loaded", response: result.value } : { kind: "error", error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [slug, model, suite, caseId]);

  if (slug === null || model === null || suite === null || caseId === null) return null;

  // The record's own model id, never the slug in the URL: that slug is lossy by
  // design, and a rerun has to name the model the endpoint knows.
  const record = state.kind === "loaded" ? state.response.record : null;

  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-[min(40rem,90vw)] flex-col border-l border-line bg-surface">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="truncate text-fg">
          {record?.model ?? model}{" "}
          <span className="text-subtle">
            · {suite} · {caseId}
          </span>
        </h2>
        {onRerun !== undefined && record !== null && (
          <button
            type="button"
            onClick={() => onRerun({ slug, model: record.model, suite: record.suite, cases: [caseId] })}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <RotateCw size={12} strokeWidth={2} aria-hidden />
            Rerun
          </button>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="close"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" && <Empty title="loading run" />}
        {state.kind === "error" && <Empty title="couldn't load this run" hint={state.error} />}
        {state.kind === "loaded" && <RunDetail record={state.response.record} />}
      </div>
    </div>
  );
}
