import type { ConfigEcho } from "../../../report/benchmark.js";
import type { RunIdentity } from "../../../report/record.js";
import { identityRows } from "../../lib/identity.js";
import { TableBox, TD } from "../Table.js";

// What one invocation was measured against, pinned so a number in the tables
// below it can be reproduced. Label/value rows rather than prose, since every
// value here is a fact to look up rather than a sentence to read.

export function IdentityTable({ identity, config }: { identity: RunIdentity; config: ConfigEcho }) {
  return (
    <TableBox className="inline-block">
      <table className="tnum">
        <tbody>
          {identityRows(identity, config).map((row) => (
            <tr key={row.label} className="border-t border-line first:border-t-0">
              <td className={`${TD} pr-6 text-subtle`}>{row.label}</td>
              <td className={TD}>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableBox>
  );
}
