import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchModelRows,
  resolveCapabilities,
  resolveContextBudget,
  validateCandidates,
  type ModelCapabilities,
  type ModelRow,
  type ValidatedModel,
} from "./capabilities.js";

/** Every test here answers the model list itself: nothing in this file reaches the network. */
async function withFetch<T>(
  answers: (() => Promise<unknown>)[],
  fn: () => Promise<T>,
): Promise<{ value: T; calls: number }> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const answer = answers[calls++];
    if (!answer) throw new Error("the model list was asked for more times than the test answers");
    return answer();
  }) as typeof fetch;
  try {
    return { value: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

function listing(rows: unknown[]): () => Promise<unknown> {
  return async () => ({ ok: true, status: 200, json: async () => ({ data: rows }) });
}

const RAW_ROW = {
  id: "vendor/model",
  architecture: { input_modalities: ["text", "image"] },
  context_length: 200_000,
  supported_parameters: ["tools", "temperature"],
  pricing: { prompt: "0.000003", completion: "0.000015" },
};

test("reads prices, tools support and modalities off the list", async () => {
  const { value } = await withFetch([listing([RAW_ROW])], () =>
    fetchModelRows("https://openrouter.ai/api/v1"),
  );
  assert.ok(value.ok);
  assert.deepEqual(value.value, [
    {
      id: "vendor/model",
      inputModalities: ["text", "image"],
      contextLength: 200_000,
      supportsTools: true,
      pricing: { promptUsdPerTok: 0.000_003, completionUsdPerTok: 0.000_015 },
    },
  ]);
});

test("prices nothing a provider bills variably", async () => {
  const variable = { ...RAW_ROW, pricing: { prompt: "-1", completion: "-1" } };
  const { value } = await withFetch([listing([variable])], () =>
    fetchModelRows("https://openrouter.ai/api/v1"),
  );
  assert.ok(value.ok);
  assert.equal(value.value[0]?.pricing, null);
});

test("drops an unreadable row rather than the whole list", async () => {
  const { value } = await withFetch([listing([{ id: "broken" }, RAW_ROW])], () =>
    fetchModelRows("https://openrouter.ai/api/v1"),
  );
  assert.ok(value.ok);
  assert.equal(value.value.length, 1);
});

test("asks the model list twice before giving up on it", async () => {
  const dead = async (): Promise<unknown> => {
    throw new Error("connection refused");
  };
  const retried = await withFetch([dead, listing([RAW_ROW])], () =>
    fetchModelRows("https://openrouter.ai/api/v1"),
  );
  assert.ok(retried.value.ok);
  assert.equal(retried.calls, 2);

  const gaveUp = await withFetch([dead, dead], () => fetchModelRows("https://openrouter.ai/api/v1"));
  assert.equal(gaveUp.value.ok, false);
  assert.equal(gaveUp.calls, 2);
});

function row(patch: Partial<ModelRow> & { id: string }): ModelRow {
  return {
    inputModalities: ["text"],
    contextLength: 128_000,
    supportsTools: true,
    pricing: { promptUsdPerTok: 0.000_003, completionUsdPerTok: 0.000_015 },
    ...patch,
  };
}

function only(models: ValidatedModel[]): ValidatedModel {
  assert.equal(models.length, 1, "expected exactly one validated model");
  return models[0] as ValidatedModel;
}

test("keeps a listed model that calls tools and reads text", () => {
  const { validated, skipped } = validateCandidates([row({ id: "vendor/model" })], [
    "vendor/model",
  ]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(only(validated), {
    id: "vendor/model",
    modalities: ["text"],
    contextLength: 128_000,
    supportsTools: true,
    pricing: { promptUsdPerTok: 0.000_003, completionUsdPerTok: 0.000_015 },
  });
});

test("skips an id no row carries instead of planning runs against it", () => {
  const { validated, skipped } = validateCandidates([row({ id: "vendor/model" })], [
    "vendor/typo",
  ]);
  assert.deepEqual(validated, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.id, "vendor/typo");
  assert.match(skipped[0]?.reason ?? "", /typo/);
});

test("skips a model that cannot call tools", () => {
  const { validated, skipped } = validateCandidates(
    [row({ id: "vendor/chat-only", supportsTools: false })],
    ["vendor/chat-only"],
  );
  assert.deepEqual(validated, []);
  assert.match(skipped[0]?.reason ?? "", /tool calls/);
});

test("skips a model that takes neither text nor image, and names what it takes", () => {
  const { validated, skipped } = validateCandidates(
    [row({ id: "vendor/voice", inputModalities: ["audio"] })],
    ["vendor/voice"],
  );
  assert.deepEqual(validated, []);
  assert.match(skipped[0]?.reason ?? "", /audio/);
});

test("keeps only the input types this host can send", () => {
  const { validated } = validateCandidates(
    [row({ id: "vendor/multi", inputModalities: ["image", "file", "text", "audio"] })],
    ["vendor/multi"],
  );
  assert.deepEqual(only(validated).modalities, ["text", "image"]);
});

/** A `:free` variant is the same weights at a different price, so its own row is the only one that can price it. */
test("prices a variant from its own row", () => {
  const { validated } = validateCandidates(
    [
      row({ id: "vendor/model" }),
      row({ id: "vendor/model:free", pricing: { promptUsdPerTok: 0, completionUsdPerTok: 0 } }),
    ],
    ["vendor/model:free"],
  );
  assert.deepEqual(only(validated).pricing, { promptUsdPerTok: 0, completionUsdPerTok: 0 });
});

test("falls back to the base row for architecture, but never for price", () => {
  const { validated } = validateCandidates(
    [row({ id: "vendor/model", contextLength: 64_000, inputModalities: ["text", "image"] })],
    ["vendor/model:beta"],
  );
  const model = only(validated);
  assert.equal(model.id, "vendor/model:beta");
  assert.equal(model.contextLength, 64_000);
  assert.deepEqual(model.modalities, ["text", "image"]);
  assert.equal(model.pricing, null);
});

test("answers every candidate, usable or not, in the order asked", () => {
  const { validated, skipped } = validateCandidates(
    [row({ id: "a/one" }), row({ id: "b/two", supportsTools: false }), row({ id: "c/three" })],
    ["a/one", "b/two", "c/three", "d/four"],
  );
  assert.deepEqual(
    validated.map((model) => model.id),
    ["a/one", "c/three"],
  );
  assert.deepEqual(
    skipped.map((model) => model.id),
    ["b/two", "d/four"],
  );
});

function validated(patch: Partial<ValidatedModel> = {}): ValidatedModel {
  return {
    id: "vendor/model",
    modalities: ["text"],
    contextLength: 128_000,
    supportsTools: true,
    pricing: null,
    ...patch,
  };
}

test("a declared modality list outranks the row, and leaves the window alone", () => {
  const capabilities = resolveCapabilities(validated(), ["text", "image"]);
  assert.equal(capabilities.source, "env");
  assert.deepEqual(capabilities.modalities, ["text", "image"]);
  assert.equal(capabilities.contextLength, 128_000);
});

test("a model nothing described is assumed to read text and images", () => {
  const capabilities = resolveCapabilities(validated({ modalities: [] }), null);
  assert.equal(capabilities.source, "assumed");
  assert.deepEqual(capabilities.modalities, ["text", "image"]);
});

function capabilities(contextLength: number | null): ModelCapabilities {
  return {
    modalities: ["text"],
    source: contextLength === null ? "assumed" : "openrouter",
    contextLength,
    detail: "test",
  };
}

test("a published window decides the budget", () => {
  const budget = resolveContextBudget(capabilities(100_000));
  assert.equal(budget.source, "derived");
  assert.equal(budget.tokens, 80_000);
});

test("no published window falls to the default", () => {
  const budget = resolveContextBudget(capabilities(null));
  assert.equal(budget.source, "default");
  assert.equal(budget.tokens, 28_000);
});
