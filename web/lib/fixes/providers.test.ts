// Unit tests for the LLM provider registry's pure helpers: the api-version query the Azure
// endpoints need, its validation, and pulling the answer out of either wire format.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiVersionProblem,
  azureBaseUrl,
  azureDeploymentProblem,
  azureEndpointProblem,
  chatCompletionsUrl,
  parseAzureBaseUrl,
} from "./provider-presets";
import { answerFromResponse, keyDestinationChanged, normalizeApiVersion, providerInputProblem } from "./providers";

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

// ── Azure form shape: endpoint + deployment <-> the single stored baseUrl ─────

test("azureBaseUrl builds the deployments path from the two parts", () => {
  assert.equal(
    azureBaseUrl("https://coregpt4.openai.azure.com", "gpt-4o-mini"),
    "https://coregpt4.openai.azure.com/openai/deployments/gpt-4o-mini"
  );
});

test("azureBaseUrl tolerates trailing/leading slashes on either part", () => {
  assert.equal(
    azureBaseUrl("https://acme.openai.azure.com///", "/gpt-4o/"),
    "https://acme.openai.azure.com/openai/deployments/gpt-4o"
  );
});

test("azureBaseUrl returns empty when a part is missing (Save stays disabled)", () => {
  assert.equal(azureBaseUrl("", "gpt-4o"), "");
  assert.equal(azureBaseUrl("https://acme.openai.azure.com", ""), "");
});

test("parseAzureBaseUrl round-trips what azureBaseUrl builds", () => {
  const built = azureBaseUrl("https://coregpt4.openai.azure.com", "gpt-4o-mini");
  assert.deepEqual(parseAzureBaseUrl(built), { endpoint: "https://coregpt4.openai.azure.com", deployment: "gpt-4o-mini" });
});

test("parseAzureBaseUrl round-trips a deployment name needing URL encoding", () => {
  const built = azureBaseUrl("https://acme.openai.azure.com", "gpt 4o");
  assert.equal(built, "https://acme.openai.azure.com/openai/deployments/gpt%204o");
  assert.deepEqual(parseAzureBaseUrl(built), { endpoint: "https://acme.openai.azure.com", deployment: "gpt 4o" });
});

test("parseAzureBaseUrl returns null for non-Azure-deployment URLs, so they open in the raw form", () => {
  assert.equal(parseAzureBaseUrl("https://api.openai.com/v1"), null);
  assert.equal(parseAzureBaseUrl("https://acme.openai.azure.com/openai/v1"), null);
  assert.equal(parseAzureBaseUrl("https://acme.openai.azure.com"), null); // the broken bare shape
  assert.equal(parseAzureBaseUrl(""), null);
});

test("parseAzureBaseUrl survives a malformed percent-escape rather than throwing", () => {
  assert.deepEqual(parseAzureBaseUrl("https://acme.openai.azure.com/openai/deployments/100%"), {
    endpoint: "https://acme.openai.azure.com",
    deployment: "100%",
  });
});

test("azureEndpointProblem rejects a URL that already has the deployment path baked in", () => {
  assert.equal(azureEndpointProblem("https://acme.openai.azure.com"), null);
  assert.equal(azureEndpointProblem("https://acme.openai.azure.com/"), null);
  assert.ok(azureEndpointProblem("https://acme.openai.azure.com/openai/deployments/gpt-4o"));
  assert.ok(azureEndpointProblem(""));
  assert.ok(azureEndpointProblem("not-a-url"));
});

test("azureDeploymentProblem rejects names that would break the path", () => {
  assert.equal(azureDeploymentProblem("gpt-4o-mini"), null);
  assert.ok(azureDeploymentProblem(""));
  assert.ok(azureDeploymentProblem("a/b"));
  assert.ok(azureDeploymentProblem("has space")); // \s is rejected
});

// The full Azure round-trip the form relies on: build -> store -> parse back into the same fields.
test("an Azure provider survives a save/edit round-trip through the stored baseUrl", () => {
  const endpoint = "https://coregpt4.openai.azure.com";
  const deployment = "gpt-4o-mini";
  const stored = azureBaseUrl(endpoint, deployment);
  assert.equal(providerInputProblem({ name: "Azure AI", adapter: "openai-compatible", baseUrl: stored, model: deployment, apiVersion: "2025-01-01-preview" }), null);
  assert.deepEqual(parseAzureBaseUrl(stored), { endpoint, deployment });
  assert.equal(
    chatCompletionsUrl(stored, "2025-01-01-preview"),
    "https://coregpt4.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview"
  );
});

// ── The re-enter-the-key guard: gated on the HOST, not the whole URL ──────────

test("keyDestinationChanged: swapping an Azure deployment (path only) does NOT demand the key", () => {
  const before = "https://coregpt4.openai.azure.com/openai/deployments/gpt-4o-mini";
  const after = "https://coregpt4.openai.azure.com/openai/deployments/gpt-4o";
  assert.equal(keyDestinationChanged(before, after), false);
});

test("keyDestinationChanged: repointing at another host DOES demand the key", () => {
  const before = "https://coregpt4.openai.azure.com/openai/deployments/gpt-4o-mini";
  assert.equal(keyDestinationChanged(before, "https://evil.example.com/openai/deployments/gpt-4o-mini"), true);
  // a sneakier one: attacker host as a subdomain-looking suffix
  assert.equal(keyDestinationChanged(before, "https://coregpt4.openai.azure.com.evil.example.com/x"), true);
});

test("keyDestinationChanged: scheme or port changes count as a different host", () => {
  assert.equal(keyDestinationChanged("https://acme.openai.azure.com", "http://acme.openai.azure.com"), true);
  assert.equal(keyDestinationChanged("https://acme.openai.azure.com", "https://acme.openai.azure.com:8443"), true);
});

test("keyDestinationChanged: fails CLOSED on an unparseable URL", () => {
  assert.equal(keyDestinationChanged("https://acme.openai.azure.com", "not-a-url"), true);
  assert.equal(keyDestinationChanged("garbage", "garbage"), true); // identical but unprovable → still demand it
  assert.equal(keyDestinationChanged("https://acme.openai.azure.com", null), true);
});

test("keyDestinationChanged: host comparison ignores case and a trailing slash", () => {
  assert.equal(keyDestinationChanged("https://ACME.openai.azure.com", "https://acme.openai.azure.com/"), false);
});
