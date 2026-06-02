import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSecret, delineaConfigured, type DelineaConfig, type Fetcher } from "./delinea";

const cfg: DelineaConfig = { baseUrl: "https://ctg.secretservercloud.com", username: "svc", password: "pw" };

// A fetcher that routes by URL: the oauth token endpoint, then the secret GET.
function fakeFetcher(secretResponse: { status: number; body?: unknown }): Fetcher {
  return async (url) => {
    if (url.includes("/oauth2/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-123" }) };
    }
    return {
      ok: secretResponse.status >= 200 && secretResponse.status < 300,
      status: secretResponse.status,
      json: async () => secretResponse.body ?? {},
    };
  };
}

test("delineaConfigured requires all three fields", () => {
  assert.equal(delineaConfigured(cfg), true);
  assert.equal(delineaConfigured({ ...cfg, password: "" }), false);
  assert.equal(delineaConfigured({ baseUrl: "", username: "", password: "" }), false);
});

test("checkSecret short-circuits on an unset / REPLACE_ME id without calling Delinea", async () => {
  let called = false;
  const spy: Fetcher = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const res = await checkSecret(cfg, "REPLACE_ME", spy);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not set/i);
  assert.equal(called, false); // never hit the network for a placeholder
});

test("checkSecret reports not-configured when the app has no Delinea creds", async () => {
  const res = await checkSecret({ baseUrl: "", username: "", password: "" }, "48213", fakeFetcher({ status: 200 }));
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not configured/i);
});

test("checkSecret returns ok + label (the secret name) on a 200, never the value", async () => {
  const res = await checkSecret(cfg, "48213", fakeFetcher({ status: 200, body: { id: 48213, name: "LogicSource 365 Admin", items: [{ fieldName: "Password", itemValue: "hunter2" }] } }));
  assert.equal(res.ok, true);
  assert.equal(res.label, "LogicSource 365 Admin");
  // the response is in scope here only to assert the value never leaks into the result shape
  assert.equal((res as Record<string, unknown>).items, undefined);
  assert.equal(JSON.stringify(res).includes("hunter2"), false);
});

test("checkSecret maps 404 / 403 / other to readable errors", async () => {
  assert.match((await checkSecret(cfg, "1", fakeFetcher({ status: 404 }))).error ?? "", /not found/i);
  assert.match((await checkSecret(cfg, "1", fakeFetcher({ status: 403 }))).error ?? "", /denied/i);
  assert.match((await checkSecret(cfg, "1", fakeFetcher({ status: 500 }))).error ?? "", /500/);
});
