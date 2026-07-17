import { test } from "node:test";
import assert from "node:assert/strict";
import { probeSecretValues, isProbeable } from "./value-probe";

const APP_GUID = "8d5e1c2a-1234-4abc-9def-0123456789ab";

// A fetcher stub for the Entra token endpoint. `ok` → 200 with a token; otherwise the AADSTS shape.
function entraFetcher(ok: boolean, code = "AADSTS7000215"): typeof fetch {
  return (async () =>
    ok
      ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      : new Response(JSON.stringify({ error: "invalid_client", error_description: `${code}: bad secret` }), { status: 401 })) as unknown as typeof fetch;
}

test("unknown secret is not probeable", async () => {
  const r = await probeSecretValues("mimecast", { ClientID: "x", ClientSecret: "y" });
  assert.equal(r.probeable, false);
  assert.equal(r.blocking, false);
  assert.equal(isProbeable("mimecast"), false);
});

test("m365: a valid app registration authenticates (blocking, ok)", async () => {
  const r = await probeSecretValues(
    "m365-admin",
    { Username: APP_GUID, Password: "secret", TenantId: "contoso.onmicrosoft.com" },
    {},
    entraFetcher(true),
  );
  assert.equal(r.probeable, true);
  assert.equal(r.blocking, true);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "live");
});

test("m365: a Global Admin account is rejected WITHOUT a network call", async () => {
  let called = false;
  const spy: typeof fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await probeSecretValues("m365-admin", { Username: "admin@contoso.com", Password: "pw", TenantId: "contoso.com" }, {}, spy);
  assert.equal(r.ok, false);
  assert.equal(r.blocking, true);
  assert.equal(called, false); // caught by shape, never hit Entra
  assert.match(r.hint ?? "", /app registration/);
});

test("m365: falls back to the client's primary domain when the secret has no tenant field", async () => {
  const r = await probeSecretValues(
    "m365-admin",
    { Username: APP_GUID, Password: "secret" },
    { clientPrimaryDomain: "contoso.com" },
    entraFetcher(true),
  );
  assert.equal(r.ok, true);
});

test("m365: no tenant and no client domain → fails before the network", async () => {
  const r = await probeSecretValues("m365-admin", { Username: APP_GUID, Password: "secret" }, {}, entraFetcher(true));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /tenant/);
});

test("m365: a bad secret surfaces the AADSTS hint", async () => {
  const r = await probeSecretValues(
    "m365-admin",
    { Username: APP_GUID, Password: "wrong", TenantId: "contoso.com" },
    {},
    entraFetcher(false, "AADSTS7000215"),
  );
  assert.equal(r.ok, false);
  assert.match(r.hint ?? "", /secret is wrong or expired/);
});

test("m365: missing app id → not ok, names the missing field", async () => {
  const r = await probeSecretValues("m365-admin", { Password: "secret", TenantId: "contoso.com" }, {}, entraFetcher(true));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /app id/);
});

test("ad-dc: advisory probe passes when the agent is servable", async () => {
  const r = await probeSecretValues("ad-dc", { Username: "svc", Password: "pw" }, { agentReach: async () => ({ servable: true }) });
  assert.equal(r.probeable, true);
  assert.equal(r.blocking, false); // advisory — never blocks the write
  assert.equal(r.ok, true);
  assert.equal(r.kind, "agent");
});

test("ad-dc: advisory probe fails (but non-blocking) when no agent is online", async () => {
  const r = await probeSecretValues("ad-dc", { Username: "svc", Password: "pw" }, { agentReach: async () => ({ servable: false, reason: "no runner online for this client" }) });
  assert.equal(r.ok, false);
  assert.equal(r.blocking, false);
  assert.match(r.error ?? "", /no runner online/);
});

test("ad-dc: not probeable when no reachability check is injected", async () => {
  const r = await probeSecretValues("ad-dc", { Username: "svc", Password: "pw" });
  assert.equal(r.probeable, false);
});
