import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatCompletionAssistantMessageParam } from "openai/resources/chat/completions";
import { createOpenAiCompatibleModel, type ChatReply } from "./chat.js";

/** Every test here answers the endpoint itself: nothing in this file reaches the network. */
async function complete(argumentsByCall: string[]): Promise<ChatReply> {
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "vendor/model",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          tool_calls: argumentsByCall.map((args, index) => ({
            id: `call_${index}`,
            type: "function",
            function: { name: "oled", arguments: args },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const model = createOpenAiCompatibleModel({
      baseUrl: "http://endpoint.test/v1",
      apiKey: "test-key",
      model: "vendor/model",
      stream: false,
      timeoutMs: 5_000,
    });
    const result = await model.complete([{ role: "user", content: "go" }], []);
    assert.ok(result.ok, "the stubbed endpoint always answers");
    return result.value;
  } finally {
    globalThis.fetch = real;
  }
}

function functionArgsAt(assistant: ChatCompletionAssistantMessageParam, index: number): string {
  const call = assistant.tool_calls?.[index];
  assert.ok(call && call.type === "function", `history call ${index} is a function call`);
  return call.function.arguments;
}

// The real gemma-4-31b-it failure shape: a provider token ceiling cut the call mid-escaped-string.
const TRUNCATED =
  '{"args":"ingest commit --file x --input -","stdin":"{\\"date\\":\\"2026-05-12\\",\\"deb';

test("keeps a valid call verbatim in both the history copy and the tool copy", async () => {
  const reply = await complete(['{"args":"status"}']);
  assert.equal(functionArgsAt(reply.assistant, 0), '{"args":"status"}');
  assert.equal(reply.toolCalls[0]?.args, '{"args":"status"}');
});

test("replaces truncated arguments with {} in the history copy only", async () => {
  const reply = await complete([TRUNCATED]);
  assert.equal(functionArgsAt(reply.assistant, 0), "{}");
  const call = reply.assistant.tool_calls?.[0];
  assert.ok(call && call.type === "function");
  assert.equal(call.id, "call_0");
  assert.equal(call.function.name, "oled");
  assert.equal(reply.toolCalls[0]?.args, TRUNCATED, "the tool still reads what the model sent");
});

test("rewrites only the malformed call when a turn carries several", async () => {
  const reply = await complete(['{"args":"status"}', TRUNCATED]);
  assert.equal(functionArgsAt(reply.assistant, 0), '{"args":"status"}');
  assert.equal(functionArgsAt(reply.assistant, 1), "{}");
  assert.equal(reply.toolCalls[0]?.args, '{"args":"status"}');
  assert.equal(reply.toolCalls[1]?.args, TRUNCATED);
});

test("valid JSON that is not an object stays verbatim", async () => {
  const reply = await complete(["[1,2]"]);
  assert.equal(functionArgsAt(reply.assistant, 0), "[1,2]");
});
