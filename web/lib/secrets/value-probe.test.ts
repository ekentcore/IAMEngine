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
  const r = await probeSecretValues("totally-unregistered-system", { ClientID: "x", ClientSecret: "y" });
  assert.equal(r.probeable, false);
  assert.equal(r.blocking, false);
  assert.equal(isProbeable("totally-unregistered-system"), false);
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

test("google-admin is registered as blocking", () => {
  assert.equal(isProbeable("google-admin"), true);
});

test("google-admin: missing the key or impersonate field fails before any network call", async () => {
  let called = false;
  const spy: typeof fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r1 = await probeSecretValues("google-admin", { apiURL: "admin@acme.com" }, {}, spy);
  assert.equal(r1.probeable, true);
  assert.equal(r1.blocking, true);
  assert.equal(r1.ok, false);
  assert.match(r1.error ?? "", /service-account key/);
  const r2 = await probeSecretValues("google-admin", { ClientSecret: "not-checked-here" }, {}, spy);
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? "", /impersonate email/);
  assert.equal(called, false);
});

test("google-admin: a malformed key fails before the network (caught by keyPemFromBase64Json)", async () => {
  let called = false;
  const spy: typeof fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await probeSecretValues("google-admin", { ClientSecret: "not-base64-json", apiURL: "admin@acme.com" }, {}, spy);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /invalid service account key/);
  assert.equal(called, false);
});

test("google-admin: a well-formed key + impersonate delegates to probeGoogleDirectory (live, blocking)", async () => {
  const saKey = Buffer.from(JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: "not-a-real-pem" })).toString("base64");
  // probeGoogleDirectory will fail signing with a fake PEM — the point here is that it was REACHED
  // (delegated to), not that it succeeds; a live success path is covered in google-verify.test.ts.
  const r = await probeSecretValues("google-admin", { ClientSecret: saKey, apiURL: "admin@acme.com" }, {});
  assert.equal(r.probeable, true);
  assert.equal(r.blocking, true);
  assert.equal(r.kind, "live");
  assert.equal(r.ok, false);
});

const okFetch = (status: number, body: unknown = {}): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

test("mimecast probe: a token response = ok", async () => {
  const r = await probeSecretValues("mimecast", { ClientId: "cid", ClientSecret: "sec" }, {}, okFetch(200, { access_token: "t" }));
  assert.equal(r.probeable, true); assert.equal(r.blocking, true); assert.equal(r.ok, true); assert.equal(r.kind, "live");
});
test("mimecast probe: 401 = not ok", async () => {
  const r = await probeSecretValues("mimecast", { ClientId: "cid", ClientSecret: "bad" }, {}, okFetch(401, { error: "invalid_client" }));
  assert.equal(r.ok, false);
});
test("mimecast probe: missing a field is refused before the network", async () => {
  const r = await probeSecretValues("mimecast", { ClientId: "cid" }, {}, okFetch(200));
  assert.equal(r.ok, false); assert.match(r.error ?? "", /client secret/i);
});
test("spanning probe: 2xx with Basic auth = ok", async () => {
  const r = await probeSecretValues("spanning", { ClientId: "acct", AccessToken: "tok", Region: "us" }, {}, okFetch(200, {}));
  assert.equal(r.ok, true);
});
test("spanning probe: 401 = not ok", async () => {
  const r = await probeSecretValues("spanning", { ClientId: "acct", AccessToken: "bad", Region: "us" }, {}, okFetch(401));
  assert.equal(r.ok, false);
});
test("spanning probe: a host-only apiURL (what the guided setup vaults) gets /external appended, https forced", async () => {
  let asked = "";
  const spy: typeof fetch = (async (url: string) => {
    asked = String(url);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await probeSecretValues("spanning", { ClientID: "a@x.com", ClientSecret: "tok", apiURL: "http://google-api-us.spanningbackup.com" }, {}, spy);
  assert.equal(r.ok, true);
  assert.match(asked, /^https:\/\/google-api-us\.spanningbackup\.com\/external\//);
});
test("proofpoint probe: 200 with X-User/X-Password + region + domain = ok", async () => {
  const r = await probeSecretValues("proofpoint", { "X-User": "a@x.com", "X-Password": "p", Region: "us1", Domain: "x.com" }, {}, okFetch(200, {}));
  assert.equal(r.ok, true);
});
test("proofpoint probe: no region -> not probeable (advisory), never a false red", async () => {
  const r = await probeSecretValues("proofpoint", { "X-User": "a@x.com", "X-Password": "p", Domain: "x.com" }, {}, okFetch(200));
  assert.equal(r.probeable, false);
});
test("proofpoint probe: domain falls back to the client's primary domain", async () => {
  let calledUrl = "";
  const spy = (async (u: string) => { calledUrl = u; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
  const r = await probeSecretValues("proofpoint", { "X-User": "a@x.com", "X-Password": "p", Region: "us1" }, { clientPrimaryDomain: "acme.com" }, spy);
  assert.equal(r.ok, true); assert.match(calledUrl, /\/orgs\/acme\.com\//);
});
test("mimecast probe: a throwing fetcher (network down / timeout) is caught, not thrown", async () => {
  const throwingFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const r = await probeSecretValues("mimecast", { ClientId: "cid", ClientSecret: "sec" }, {}, throwingFetch);
  assert.equal(r.probeable, true);
  assert.equal(r.blocking, true);
  assert.equal(r.ok, false);
});
