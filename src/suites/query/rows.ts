import { readFileSync } from "node:fs";
import * as z from "zod";
import { tryExecute, type Result } from "../../core/result.js";

/**
 * The seeded ledger's rows, in the shape `oled ingest commit` reads from stdin.
 * They are what a sandbox is filled with and nothing else: a golden is read back
 * out of oled afterwards, never computed from these.
 */
const ROW = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  description: z.string().min(1),
  debit_account: z.string().min(1),
  credit_account: z.string().min(1),
  /** Decimal major units, as oled reads them; the derivation works in minor units. */
  amount: z.number().positive(),
  merchant: z.object({ canonical_name: z.string().min(1) }).optional(),
});

export type SeedRow = z.infer<typeof ROW>;

export function readRows(path: string): Result<SeedRow[]> {
  const text = tryExecute(() => readFileSync(path, "utf8"));
  if (!text.ok) return { ok: false, error: `cannot read ${path}: ${text.error}` };

  const rows: SeedRow[] = [];
  const lines = text.value.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const json = tryExecute(() => JSON.parse(line) as unknown);
    if (!json.ok) return { ok: false, error: `${path}:${index + 1} is not JSON: ${json.error}` };

    const parsed = ROW.safeParse(json.value);
    if (!parsed.success) {
      return { ok: false, error: `${path}:${index + 1}: ${z.prettifyError(parsed.error)}` };
    }
    rows.push(parsed.data);
  }
  if (rows.length === 0) return { ok: false, error: `${path} holds no rows` };
  return { ok: true, value: rows };
}
