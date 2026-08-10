import { Check, Minus, X, type LucideIcon } from "lucide-react";
import type { AssertionResult } from "../../../suites/types.js";
import { Badge, type Tone } from "../Badge.js";
import { TableBox, TD, TH } from "../Table.js";

// Every assertion a grade carried, worst news first. `na` never counts as a
// failure — it had nothing to judge — so it is left wherever it already sat
// rather than pulled to either end.

/** Failures move to the front; everything else — passed or `na` — keeps its original order. */
function ordered(assertions: AssertionResult[]): AssertionResult[] {
  const failed = assertions.filter((assertion) => !assertion.passed && assertion.na !== true);
  const rest = assertions.filter((assertion) => assertion.passed || assertion.na === true);
  return [...failed, ...rest];
}

type Verdict = "na" | "passed" | "failed";

function verdictOf(assertion: AssertionResult): Verdict {
  if (assertion.na) return "na";
  return assertion.passed ? "passed" : "failed";
}

/** The word already carries the fact; the badge repeats it, and only a real failure is loud. */
const VERDICT: Record<Verdict, { label: string; tone: Tone; Icon: LucideIcon }> = {
  na: { label: "not applicable", tone: "muted", Icon: Minus },
  passed: { label: "passed", tone: "accent", Icon: Check },
  failed: { label: "failed", tone: "bad", Icon: X },
};

export function ChecksTable({ assertions }: { assertions: AssertionResult[] }) {
  if (assertions.length === 0) return <p className="text-subtle">no checks recorded</p>;

  return (
    <TableBox>
      <table className="tnum w-full">
        <thead>
          <tr className="text-subtle">
            <th scope="col" className={TH}>
              Check
            </th>
            <th scope="col" className={TH}>
              Result
            </th>
            <th scope="col" className={TH}>
              Want
            </th>
            <th scope="col" className={TH}>
              Got
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered(assertions).map((assertion) => {
            const verdict = VERDICT[verdictOf(assertion)];
            return (
              <tr
                key={assertion.id}
                className={`border-t border-line align-top ${assertion.na ? "text-subtle" : ""}`}
              >
                <td className={TD}>{assertion.label}</td>
                <td className={TD}>
                  <Badge tone={verdict.tone}>
                    <verdict.Icon size={11} strokeWidth={2.5} aria-hidden />
                    {verdict.label}
                  </Badge>
                </td>
                <td className={`${TD} break-all`}>{assertion.evidence.want}</td>
                <td className={`${TD} break-all`}>{assertion.evidence.got}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableBox>
  );
}
