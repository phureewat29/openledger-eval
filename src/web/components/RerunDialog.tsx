import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SuiteId } from "../../shared/vocabulary.js";
import { post } from "../lib/api.js";
import { plural } from "../lib/format.js";
import { estimate, useScale } from "../lib/scale.js";
import { Confirm } from "./Confirm.js";

// Running part of a finished report again, into the report it came from. The
// result overwrites that cell's run file and the leaderboard is rebuilt around
// it, so one iteration directory stays the single account of that iteration.
//
// There is no "run it as a new iteration" branch. A rerun always merges back —
// even one measured against a newer build, which the report records as spanning
// builds rather than refusing.

/** One model's cases of one suite; an empty `cases` is the whole suite, which is the grid's row. */
export interface RerunScope {
  slug: string;
  model: string;
  suite: SuiteId;
  cases: string[];
}

function whatOf(scope: RerunScope): string {
  if (scope.cases.length === 1) return `case ${scope.cases[0]}`;
  if (scope.cases.length > 1) return `${scope.cases.length} cases`;
  return `the whole ${scope.suite} suite`;
}

export function RerunDialog({ scope, onClose }: { scope: RerunScope | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scale = useScale();
  const navigate = useNavigate();

  if (scope === null) return null;

  const runs = scope.cases.length > 0 ? scope.cases.length : (scale.cases[scope.suite] ?? 0);

  const close = (): void => {
    setError(null);
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
    if (!result.ok) return setError(result.error);
    close();
    // Straight to the live screen: a rerun is worth watching for the same reason
    // a launch is, and the grid it was started from is about to be out of date.
    navigate("/");
  };

  return (
    <Confirm
      title={`Rerun ${whatOf(scope)}?`}
      action={runs > 0 ? `Rerun ${plural(runs, "run")}` : "Rerun"}
      tone="accent"
      busy={sending}
      error={error}
      onConfirm={() => void rerun()}
      onCancel={close}
    >
      <p className="tnum">
        {scope.model} · {scope.suite}
        {runs > 0 && ` · ${plural(runs, "run")}`}
        {estimate(scale, runs)}
      </p>
      <p>
        The result replaces what {scope.slug} holds for {scope.cases.length === 1 ? "that cell" : "those cells"}
        , and its leaderboard is rebuilt around it. Every other cell in the report is left exactly as it is.
      </p>
    </Confirm>
  );
}
