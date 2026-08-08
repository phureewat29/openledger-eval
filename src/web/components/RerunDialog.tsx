import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SuiteId } from "../../config.js";
import type { Drift } from "../../server/drift.js";
import { post } from "../lib/api.js";
import { estimate, useScale } from "../lib/scale.js";
import { Confirm } from "./Confirm.js";

// Running part of a finished report again, into the report it came from. The
// result overwrites that cell's run file and the leaderboard is rebuilt around
// it, so one iteration directory stays the single account of that iteration.

/** One model's cases of one suite; an empty `cases` is the whole suite, which is the grid's row. */
export interface RerunScope {
  slug: string;
  model: string;
  suite: SuiteId;
  cases: string[];
}

function driftOf(body: unknown): Drift | null {
  const drift = (body as { drift?: Drift } | null)?.drift;
  return drift?.what === undefined ? null : drift;
}

export function RerunDialog({ scope, onClose }: { scope: RerunScope | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState<Drift | null>(null);
  const [sending, setSending] = useState(false);
  const scale = useScale();
  const navigate = useNavigate();

  if (scope === null) return null;

  const runs = scope.cases.length > 0 ? scope.cases.length : (scale.cases[scope.suite] ?? 0);
  const what =
    scope.cases.length === 1
      ? `case ${scope.cases[0]}`
      : scope.cases.length > 1
        ? `${scope.cases.length} cases`
        : `the whole ${scope.suite} suite`;

  const close = (): void => {
    setError(null);
    setDrift(null);
    onClose();
  };

  const rerun = async (): Promise<void> => {
    setSending(true);
    setError(null);
    const result = await post(`/api/iterations/${scope.slug}/rerun`, {
      model: scope.model,
      suite: scope.suite,
      cases: scope.cases,
    });
    setSending(false);
    if (!result.ok) {
      setDrift(driftOf(result.body));
      return setError(result.error);
    }
    close();
    // Straight to the live screen: a rerun is worth watching for the same reason
    // a launch is, and the grid it was started from is about to be out of date.
    navigate("/");
  };

  // Merging is refused, so the only thing left that answers the same question is
  // a fresh iteration — which the launcher can only do a whole suite at a time.
  const asNew = async (): Promise<void> => {
    setSending(true);
    setError(null);
    const result = await post("/api/launch", { suites: [scope.suite], models: [scope.model] });
    setSending(false);
    if (!result.ok) return setError(result.error);
    close();
    navigate("/");
  };

  if (drift !== null) {
    return (
      <Confirm
        title="Measured against a different build"
        action={`Run ${scope.suite} as a new iteration`}
        tone="accent"
        busy={sending}
        onConfirm={() => void asNew()}
        onCancel={close}
      >
        <p>
          Every number in {scope.slug} was measured against {drift.what} {drift.pinned}, and this checkout now
          has {drift.current}. A result from the newer build merged into that report would be averaged into its
          pass rates without anything saying so.
        </p>
        <p>
          A new iteration keeps both readings and compares them honestly. It runs the whole {scope.suite} suite
          for {scope.model}
          {estimate(scale, scale.cases[scope.suite] ?? 0)}.
        </p>
      </Confirm>
    );
  }

  return (
    <Confirm
      title={`Rerun ${what}?`}
      action={runs > 0 ? `Rerun ${runs} ${runs === 1 ? "run" : "runs"}` : "Rerun"}
      tone="accent"
      busy={sending}
      error={error}
      onConfirm={() => void rerun()}
      onCancel={close}
    >
      <p className="tnum">
        {scope.model} · {scope.suite}
        {runs > 0 && ` · ${runs} ${runs === 1 ? "run" : "runs"}`}
        {estimate(scale, runs)}
      </p>
      <p>
        The result replaces what {scope.slug} holds for {scope.cases.length === 1 ? "that cell" : "those cells"}
        , and its leaderboard is rebuilt around it. Every other cell in the report is left exactly as it is.
      </p>
    </Confirm>
  );
}
