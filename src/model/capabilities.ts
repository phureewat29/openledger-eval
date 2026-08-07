import * as z from "zod";
import { tryExecute, type Result } from "../core/result.js";

/**
 * Modalities and context budget must both be known before the run starts:
 * getting either wrong misattributes an endpoint failure to the model.
 */

export const MODALITIES = ["text", "image"] as const;

export type Modality = (typeof MODALITIES)[number];

export const MODALITIES_ENV = "LLM_INPUT_MODALITIES";

/** USD per token, the unit OpenRouter prices in. */
export interface ModelPricing {
  promptUsdPerTok: number;
  completionUsdPerTok: number;
}

/** One entry of the model list, reduced to what the eval reads. */
export interface ModelRow {
  id: string;
  /** Raw, so a skip can name what the model does take. */
  inputModalities: string[];
  contextLength: number | null;
  supportsTools: boolean;
  /** null when the row prices nothing, or prices at a variable rate. */
  pricing: ModelPricing | null;
}

/** A candidate the list vouched for: it calls tools and can be sent a statement. */
export interface ValidatedModel {
  id: string;
  modalities: Modality[];
  contextLength: number | null;
  supportsTools: boolean;
  pricing: ModelPricing | null;
}

export interface SkippedModel {
  id: string;
  reason: string;
}

const MODELS_PATH = "/models";
const FETCH_TIMEOUT_MS = 15_000;
const TOOLS_PARAMETER = "tools";

const MODEL_LIST = z.object({ data: z.array(z.unknown()) });

const RAW_ROW = z.object({
  id: z.string(),
  architecture: z.object({ input_modalities: z.array(z.string()) }),
  context_length: z.number().positive().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  pricing: z.object({ prompt: z.string(), completion: z.string() }).nullish(),
});

type RawPricing = z.infer<typeof RAW_ROW>["pricing"];

/** A rate arrives as a decimal string; `-1` means the provider bills variably, which is no rate at all. */
function rate(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pricingOf(pricing: RawPricing): ModelPricing | null {
  if (!pricing) return null;
  const prompt = rate(pricing.prompt);
  const completion = rate(pricing.completion);
  if (prompt === null || completion === null) return null;
  return { promptUsdPerTok: prompt, completionUsdPerTok: completion };
}

/** Rows are parsed one at a time: a single odd entry among hundreds must not lose the rest. */
function toRow(raw: unknown): ModelRow | null {
  const parsed = RAW_ROW.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  return {
    id: row.id,
    inputModalities: row.architecture.input_modalities,
    contextLength: row.context_length ?? null,
    supportsTools: (row.supported_parameters ?? []).includes(TOOLS_PARAMETER),
    pricing: pricingOf(row.pricing),
  };
}

async function requestRows(url: string): Promise<Result<ModelRow[]>> {
  const response = await tryExecute(() =>
    fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  );
  if (!response.ok) return { ok: false, error: `the model list did not answer: ${response.error}` };
  if (!response.value.ok) {
    return { ok: false, error: `the model list answered ${response.value.status}` };
  }

  const body = await tryExecute(() => response.value.json());
  if (!body.ok) return { ok: false, error: `the model list was unreadable: ${body.error}` };

  const parsed = MODEL_LIST.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: `the model list had an unexpected shape: ${z.prettifyError(parsed.error)}`,
    };
  }

  const rows = parsed.data.data.map(toRow).filter((row): row is ModelRow => row !== null);
  if (rows.length === 0) return { ok: false, error: "the model list carried no readable rows" };
  return { ok: true, value: rows };
}

/** Fetched once per invocation: every candidate is answered from this one list. */
export async function fetchModelRows(baseUrl: string): Promise<Result<ModelRow[]>> {
  const url = `${baseUrl.replace(/\/+$/, "")}${MODELS_PATH}`;
  const first = await requestRows(url);
  if (first.ok) return first;
  return requestRows(url);
}

/** OpenRouter serves variants as `<id>:free`; a variant runs the base model's weights at its own price. */
function baseId(model: string): string {
  return model.split(":")[0] ?? model;
}

// Ordered per MODALITIES; drops types this host can't send (file, audio, video).
function known(values: string[]): Modality[] {
  return MODALITIES.filter((modality) => values.includes(modality));
}

type Candidate = { ok: true; value: ValidatedModel } | { ok: false; reason: string };

function validateOne(byId: Map<string, ModelRow>, id: string): Candidate {
  const exact = byId.get(id) ?? null;
  const shape = exact ?? byId.get(baseId(id)) ?? null;
  if (!shape) return { ok: false, reason: "no model with that id is listed; check it for a typo" };
  if (!shape.supportsTools) return { ok: false, reason: "the model does not accept tool calls" };

  const modalities = known(shape.inputModalities);
  if (modalities.length === 0) {
    const takes = shape.inputModalities.join(", ") || "nothing this host can send";
    return { ok: false, reason: `takes neither text nor image input, only ${takes}` };
  }
  return {
    ok: true,
    value: {
      id,
      modalities,
      contextLength: shape.contextLength,
      supportsTools: true,
      // Only from the exact row: a variant priced off its base would bill the run wrongly.
      pricing: exact?.pricing ?? null,
    },
  };
}

/** Every id is answered: an unusable one is skipped with a reason, never planned into a run that can only stall. */
export function validateCandidates(
  rows: ModelRow[],
  ids: string[],
): { validated: ValidatedModel[]; skipped: SkippedModel[] } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const validated: ValidatedModel[] = [];
  const skipped: SkippedModel[] = [];
  for (const id of ids) {
    const candidate = validateOne(byId, id);
    if (candidate.ok) validated.push(candidate.value);
    else skipped.push({ id, reason: candidate.reason });
  }
  return { validated, skipped };
}

/** env: declared by hand. openrouter: read from the model list. assumed: no row described it. */
export type ModalitySource = "env" | "openrouter" | "assumed";

export interface ModelCapabilities {
  modalities: Modality[];
  source: ModalitySource;
  contextLength: number | null;
  detail: string;
}

const ASSUMED: Modality[] = ["text", "image"];

/** The declared list wins: it is the only way past a model list that describes the endpoint wrongly. */
export function resolveCapabilities(
  model: ValidatedModel,
  override: Modality[] | null,
): ModelCapabilities {
  if (override) {
    return {
      modalities: override,
      source: "env",
      contextLength: model.contextLength,
      detail: `declared by ${MODALITIES_ENV}`,
    };
  }
  if (model.modalities.length === 0) {
    return {
      modalities: ASSUMED,
      source: "assumed",
      contextLength: model.contextLength,
      detail: `nothing describes ${model.id}; assumed text and image, override with ${MODALITIES_ENV}`,
    };
  }
  return {
    modalities: model.modalities,
    source: "openrouter",
    contextLength: model.contextLength,
    detail: "read from the OpenRouter model list",
  };
}

/** derived: a share of the model's own window. default: the endpoint reported none. */
export type BudgetSource = "derived" | "default";

export interface ContextBudget {
  tokens: number;
  source: BudgetSource;
  detail: string;
}

// Room for the reply, and for a chars/4 estimate that runs under the truth.
const WINDOW_SHARE = 0.8;

// Small enough to be safe on a model that reports no window at all.
const DEFAULT_BUDGET_TOKENS = 28_000;

/**
 * The model's own window decides the budget. An endpoint that publishes none
 * falls to the default, which a small model behind a silent endpoint overflows
 * with no other way out.
 */
export function resolveContextBudget(capabilities: ModelCapabilities): ContextBudget {
  const window = capabilities.contextLength;
  if (window === null) {
    return {
      tokens: DEFAULT_BUDGET_TOKENS,
      source: "default",
      detail: `${capabilities.detail}, so no window to derive from; used the ${DEFAULT_BUDGET_TOKENS}-token default`,
    };
  }
  return {
    tokens: Math.floor(window * WINDOW_SHARE),
    source: "derived",
    detail: `${WINDOW_SHARE * 100}% of the model's ${window}-token window`,
  };
}
