import type { AssertionResult } from "../../../suites/types.js";
import { Check, Minus, X } from "lucide-react";
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

function resultLabel(assertion: AssertionResult): string {
  if (assertion.na) return "not applicable";
  return assertion.passed ? "passed" : "failed";
}

/** The word already carries the fact; the badge repeats it, and only a real failure is loud. */
function resultTone(assertion: AssertionResult): Tone {
  if (assertion.na) return "muted";
  return assertion.passed ? "accent" : "bad";
}

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
        {ordered(assertions).map((assertion) => (
          <tr key={assertion.id} className={`border-t border-line align-top ${assertion.na ? "text-subtle" : ""}`}>
            <td className={TD}>{assertion.label}</td>
            <td className={TD}>
              <Badge tone={resultTone(assertion)}>
                {assertion.na ? (
                  <Minus size={11} strokeWidth={2.5} aria-hidden />
                ) : assertion.passed ? (
                  <Check size={11} strokeWidth={2.5} aria-hidden />
                ) : (
                  <X size={11} strokeWidth={2.5} aria-hidden />
                )}
                {resultLabel(assertion)}
              </Badge>
            </td>
            <td className={`${TD} break-all`}>{assertion.evidence.want}</td>
            <td className={`${TD} break-all`}>{assertion.evidence.got}</td>
          </tr>
        ))}
      </tbody>
      </table>
    </TableBox>
  );
}
