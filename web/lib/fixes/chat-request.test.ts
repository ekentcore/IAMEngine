// Tests for the model-aware chat body. The error strings below are VERBATIM from Azure, captured
// by scripts/azure-llm-probe.mjs against gpt-5.4 and gpt-5.6-luna on a live resource.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adaptQuirks,
  buildChatBody,
  chatWithAdaptation,
  DEFAULT_QUIRKS,
  forgetQuirks,
  guessQuirks,
  REASONING_FLOOR,
  tokenBudget,
  type ChatQuirks,
} from "./chat-request";

const AZURE_MAX_TOKENS_ERROR = {
  error: {
    code: "unsupported_parameter",
    param: "max_tokens",
    message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
  },
};

const AZURE_TEMPERATURE_ERROR = {
  error: {
    code: "unsupported_value",
    param: "temperature",
    message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
  },
};

const MESSAGES = [{ role: "user", content: "hi" }];
const params = (over = {}) => ({ model: "gpt-4o", messages: MESSAGES, maxTokens: 100, ...over });

test("guessQuirks: classic models keep max_tokens", () => {
  for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-35-turbo", "claude-sonnet-5", "meta-llama/Llama-3.3-70B-Instruct"]) {
    assert.equal(guessQuirks(m).tokenParam, "max_tokens", m);
  }
});

test("guessQuirks: reasoning families are guessed onto max_completion_tokens", () => {
  for (const m of ["gpt-5", "gpt-5.4", "gpt-5.6-luna", "o1-mini", "o3", "gpt-5-nano"]) {
    assert.equal(guessQuirks(m).tokenParam, "max_completion_tokens", m);
  }
});

test("guessQuirks stays optimistic about temperature — gpt-5.4 accepts it, so we don't give it up early", () => {
  assert.equal(guessQuirks("gpt-5.4").allowTemperature, true);
});

test("buildChatBody puts the budget under the parameter the model wants", () => {
  const classic = buildChatBody(DEFAULT_QUIRKS, params());
  assert.equal(classic.max_tokens, 100);
  assert.equal("max_completion_tokens" in classic, false);

  const reasoning = buildChatBody({ tokenParam: "max_completion_tokens", allowTemperature: true }, params());
  assert.ok(reasoning.max_completion_tokens);
  assert.equal("max_tokens" in reasoning, false);
});

test("buildChatBody omits temperature entirely when the model refuses it", () => {
  const allowed = buildChatBody(DEFAULT_QUIRKS, params({ temperature: 0 }));
  assert.equal(allowed.temperature, 0);

  const refused = buildChatBody({ tokenParam: "max_completion_tokens", allowTemperature: false }, params({ temperature: 0 }));
  assert.equal("temperature" in refused, false, "must be absent, not 0 — the model only allows its default");
});

test("tokenBudget raises the floor for reasoning models — UNCONDITIONALLY", () => {
  const reasoning: ChatQuirks = { tokenParam: "max_completion_tokens", allowTemperature: true };
  // Observed on gpt-5.6-luna: max_completion_tokens:1 is a hard 400 ("Could not finish the message
  // because max_tokens or model output limit was reached"), NOT a truncated reply. So even a bare
  // connectivity ping must be given room to think — there is no 1-token request to these models.
  assert.equal(tokenBudget(reasoning, 1), REASONING_FLOOR, "the 1-token ping must be raised, or it 400s");
  assert.equal(tokenBudget(reasoning, 9000), 9000, "a bigger explicit budget is respected");
  // Classic models are never inflated — a gpt-4o ping stays a 1-token ping.
  assert.equal(tokenBudget(DEFAULT_QUIRKS, 1), 1);
});

test("adaptQuirks reads Azure's max_tokens complaint and switches the parameter", () => {
  const adapted = adaptQuirks(DEFAULT_QUIRKS, AZURE_MAX_TOKENS_ERROR);
  assert.deepEqual(adapted, { tokenParam: "max_completion_tokens", allowTemperature: true });
});

test("adaptQuirks reads the temperature complaint and gives temperature up", () => {
  const adapted = adaptQuirks({ tokenParam: "max_completion_tokens", allowTemperature: true }, AZURE_TEMPERATURE_ERROR);
  assert.deepEqual(adapted, { tokenParam: "max_completion_tokens", allowTemperature: false });
});

test("adaptQuirks returns null for errors it can't fix — a real failure must not be retried", () => {
  assert.equal(adaptQuirks(DEFAULT_QUIRKS, { error: { code: "401", message: "Access denied due to invalid subscription key" } }), null);
  assert.equal(adaptQuirks(DEFAULT_QUIRKS, { error: { code: "404", message: "Resource not found" } }), null);
  assert.equal(adaptQuirks(DEFAULT_QUIRKS, null), null);
  assert.equal(adaptQuirks(DEFAULT_QUIRKS, {}), null);
});

test("adaptQuirks won't loop: it never re-suggests a change already applied", () => {
  const already: ChatQuirks = { tokenParam: "max_completion_tokens", allowTemperature: true };
  assert.equal(adaptQuirks(already, AZURE_MAX_TOKENS_ERROR), null, "already on max_completion_tokens");
  const noTemp: ChatQuirks = { tokenParam: "max_completion_tokens", allowTemperature: false };
  assert.equal(adaptQuirks(noTemp, AZURE_TEMPERATURE_ERROR), null, "temperature already dropped");
});

// ── the whole loop, against a fake Azure that behaves exactly like gpt-5.6-luna ───────────────

function fakeAzure(rules: { rejectMaxTokens?: boolean; rejectTemperature?: boolean }) {
  const seen: Array<Record<string, unknown>> = [];
  const impl = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push(body);
    if (rules.rejectMaxTokens && "max_tokens" in body) {
      return new Response(JSON.stringify(AZURE_MAX_TOKENS_ERROR), { status: 400 });
    }
    if (rules.rejectTemperature && "temperature" in body) {
      return new Response(JSON.stringify(AZURE_TEMPERATURE_ERROR), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "PONG" } }] }), { status: 200 });
  };
  return { seen, impl: impl as unknown as typeof fetch };
}

test("chatWithAdaptation: a gpt-4o-shaped model succeeds on the first try", async () => {
  forgetQuirks();
  const azure = fakeAzure({});
  const r = await chatWithAdaptation("https://x/chat/completions", {}, params({ model: "gpt-4o", temperature: 0 }), { fetchImpl: azure.impl });
  assert.equal(r.ok, true);
  assert.equal(azure.seen.length, 1);
  assert.equal(azure.seen[0].max_tokens, 100);
  assert.equal(azure.seen[0].temperature, 0);
});

test("chatWithAdaptation: gpt-5.6-luna — rejects max_tokens AND temperature, and we end up correct", async () => {
  forgetQuirks();
  const azure = fakeAzure({ rejectMaxTokens: true, rejectTemperature: true });
  const r = await chatWithAdaptation(
    "https://x/chat/completions",
    {},
    params({ model: "gpt-5.6-luna", temperature: 0, maxTokens: 100 }),
    { fetchImpl: azure.impl }
  );
  assert.equal(r.ok, true, "must recover");
  const final = azure.seen[azure.seen.length - 1];
  assert.equal("max_tokens" in final, false);
  assert.equal("temperature" in final, false);
  assert.equal(final.max_completion_tokens, REASONING_FLOOR, "and it got a real budget, not 100");
});

test("chatWithAdaptation: an UNGUESSED reasoning model still recovers, purely from the error", async () => {
  forgetQuirks();
  const azure = fakeAzure({ rejectMaxTokens: true });
  // A name our regex knows nothing about — the point is that the error, not the table, is authority.
  const r = await chatWithAdaptation("https://x/chat/completions", {}, params({ model: "orion-vnext" }), { fetchImpl: azure.impl });
  assert.equal(r.ok, true);
  assert.equal(azure.seen[0].max_tokens, 100, "first attempt used the wrong guess");
  assert.equal(azure.seen[1].max_completion_tokens, REASONING_FLOOR, "second attempt did what Azure said");
});

test("chatWithAdaptation: what it learns is cached, so the doomed attempt happens once per process", async () => {
  forgetQuirks();
  const first = fakeAzure({ rejectMaxTokens: true });
  await chatWithAdaptation("https://x/chat/completions", {}, params({ model: "orion-vnext" }), { fetchImpl: first.impl });
  assert.equal(first.seen.length, 2, "learned the hard way");

  const second = fakeAzure({ rejectMaxTokens: true });
  const r = await chatWithAdaptation("https://x/chat/completions", {}, params({ model: "orion-vnext" }), { fetchImpl: second.impl });
  assert.equal(r.ok, true);
  assert.equal(second.seen.length, 1, "straight to the right shape");
  assert.ok(second.seen[0].max_completion_tokens);
});

test("chatWithAdaptation: an unrecoverable error is surfaced, not retried", async () => {
  forgetQuirks();
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: "401", message: "Access denied" } }), { status: 401 });
  }) as unknown as typeof fetch;
  const r = await chatWithAdaptation("https://x/chat/completions", {}, params(), { fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(calls, 1, "must not retry a 401");
});
