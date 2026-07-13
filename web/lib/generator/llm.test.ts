import { test } from "node:test";
import assert from "node:assert/strict";
import { azureChatJson, type AzureConfig } from "./llm";

const cfg: AzureConfig = { endpoint: "https://x", apiKey: "k", deployment: "d", apiVersion: "v" };

test("redacts secrets from the user message before sending to Azure", async () => {
  const original = globalThis.fetch;
  let sentBody = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sentBody = String(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) } as Response;
  }) as typeof fetch;
  try {
    const out = await azureChatJson(cfg, "system prompt", "Password: https://x.secretservercloud.com/secrets/1 for jane@acme.com");
    assert.deepEqual(out, { ok: true });
    assert.doesNotMatch(sentBody, /secretservercloud/, "vault URL must not be sent");
    assert.doesNotMatch(sentBody, /jane@acme/, "email local part must not be sent");
    assert.match(sentBody, /system prompt/, "system prompt is sent unchanged");
  } finally {
    globalThis.fetch = original;
  }
});

test("restores masked email addresses in the model's response (reversible round-trip)", async () => {
  const original = globalThis.fetch;
  let sentBody = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sentBody = String(init.body);
    // The model echoes the placeholder back (as the extractor does with runbook steps).
    const m = sentBody.match(/\[u1\]@dcg\.co/);
    assert.ok(m, "placeholder must be in the sent body");
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"step":"Add the user to [u1]@dcg.co"}' } }] }) } as Response;
  }) as typeof fetch;
  try {
    const out = await azureChatJson(cfg, "sys", "Add the user to groups: DCG@dcg.co");
    assert.doesNotMatch(sentBody, /DCG@dcg\.co/i, "real address never leaves the boundary");
    assert.deepEqual(out, { step: "Add the user to DCG@dcg.co" });
  } finally {
    globalThis.fetch = original;
  }
});
