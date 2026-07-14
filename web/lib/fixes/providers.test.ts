// Unit tests for the LLM provider registry's pure helpers: the api-version query the Azure
// endpoints need, its validation, and pulling the answer out of either wire format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiVersionProblem, chatCompletionsUrl } from "./provider-presets";
import { answerFromResponse, normalizeApiVersion, providerInputProblem } from "./providers";

test("chatCompletionsUrl omits api-version when none is pinned", () => {
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1", null), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1", ""), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1", "  "), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1", undefined), "https://api.openai.com/v1/chat/completions");
});

test("chatCompletionsUrl appends api-version for Azure's classic deployments path", () => {
  assert.equal(
    chatCompletionsUrl("https://acme.openai.azure.com/openai/deployments/gpt4o", "2024-10-21"),
    "https://acme.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21"
  );
});

test("chatCompletionsUrl strips trailing slashes before appending", () => {
  assert.equal(
    chatCompletionsUrl("https://acme.openai.azure.com/openai/v1///", "preview"),
    "https://acme.openai.azure.com/openai/v1/chat/completions?api-version=preview"
  );
});

test("apiVersionProblem accepts the real Azure shapes and blank", () => {
  for (const v of ["2024-10-21", "2025-01-01-preview", "preview", "v1", "", null, undefined]) {
    assert.equal(apiVersionProblem(v), null, `expected ${JSON.stringify(v)} to be accepted`);
  }
});

test("apiVersionProblem rejects junk that would break the query string", () => {
  assert.ok(apiVersionProblem("2024-10-21&foo=bar"));
  assert.ok(apiVersionProblem("has space"));
  assert.ok(apiVersionProblem("x".repeat(41)));
  assert.ok(apiVersionProblem(42));
});

test("normalizeApiVersion turns blank into null so the param is dropped entirely", () => {
  assert.equal(normalizeApiVersion(""), null);
  assert.equal(normalizeApiVersion("   "), null);
  assert.equal(normalizeApiVersion(undefined), null);
  assert.equal(normalizeApiVersion(" 2024-10-21 "), "2024-10-21");
});

test("providerInputProblem validates apiVersion alongside the other fields", () => {
  const base = { name: "Azure AI", adapter: "openai-compatible", baseUrl: "https://acme.openai.azure.com/openai/v1", model: "gpt-4o" };
  assert.equal(providerInputProblem({ ...base, apiVersion: "2024-10-21" }), null);
  assert.equal(providerInputProblem(base), null, "an absent apiVersion is fine");
  assert.ok(providerInputProblem({ ...base, apiVersion: "bad version" }));
});

test("answerFromResponse reads the openai-compatible shape", () => {
  const json = { choices: [{ message: { content: "  I am gpt-4o.  " } }] };
  assert.equal(answerFromResponse("openai-compatible", json), "I am gpt-4o.");
});

test("answerFromResponse concatenates anthropic text blocks and ignores non-text ones", () => {
  const json = { content: [{ type: "text", text: "I am " }, { type: "tool_use", id: "x" }, { type: "text", text: "Claude." }] };
  assert.equal(answerFromResponse("anthropic", json), "I am Claude.");
});

test("answerFromResponse returns empty string on a malformed body rather than throwing", () => {
  assert.equal(answerFromResponse("openai-compatible", null), "");
  assert.equal(answerFromResponse("anthropic", {}), "");
  assert.equal(answerFromResponse("openai-compatible", { choices: [] }), "");
});
