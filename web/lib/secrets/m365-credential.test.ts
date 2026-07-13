import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyM365Credential, probeEntraClientCredentials } from "./m365-credential";

// The bug this guards, found in production on .406 Ventures (core61): the recovery sweep wired
// "Office 365 Global Admin" — a real, working Global Admin account — into m365-admin. It has a
// Username and a Password, so the field-NAME check passed and the app showed it green. But
// Connect-CtgM365 uses -ClientSecretCredential (the client-credentials flow), which needs an APP
// REGISTRATION: UserName must be the app id. Entra rejected it with AADSTS700016 at run time.
// Only the VALUE's shape can tell a person from an application.

test("a Global Admin user account is NOT an app registration", () => {
  const v = classifyM365Credential({ Username: "admin@406ventures.com", Password: "hunter2" });
  assert.equal(v.kind, "user-account");
  assert.match(v.reason, /UPN|person/i);
});

test("an app registration (app id GUID + secret + tenant) is accepted", () => {
  const v = classifyM365Credential({
    Username: "8d5e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
    Password: "client-secret",
    TenantId: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(v.kind, "app-registration");
});

test("the Automation - Azure App spelling (appID/Secret/tenantID) is an app registration", () => {
  const v = classifyM365Credential({
    appID: "8d5e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
    Secret: "client-secret",
    tenantID: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(v.kind, "app-registration");
});

test("a username that is neither a GUID nor an email is still not an app registration", () => {
  const v = classifyM365Credential({ Username: "svc_m365admin", Password: "p", TenantId: "t" });
  assert.equal(v.kind, "user-account");
});

test("a missing app id or secret reports as incomplete, not as the wrong kind", () => {
  // incomplete = possibly the right secret with a field to fill in; wrong-kind = never usable.
  assert.equal(classifyM365Credential({ Username: "8d5e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6" }).kind, "incomplete");
  assert.equal(classifyM365Credential({ Password: "p" }).kind, "incomplete");
  // app id + secret but no tenant anywhere
  assert.equal(
    classifyM365Credential({ appID: "8d5e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6", Secret: "s" }).kind,
    "incomplete"
  );
});

test("a blank field does not shadow a populated synonym", () => {
  const v = classifyM365Credential({
    Username: "   ",
    appID: "8d5e1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6",
    Password: "",
    Secret: "s",
    tenantID: "t",
  });
  assert.equal(v.kind, "app-registration");
});

test("the live probe performs a client-credentials grant and translates Entra's error code", async () => {
  let seen: { url: string; body: string } | null = null;
  const fake = (async (url: string, init?: { body?: string }) => {
    seen = { url, body: init?.body ?? "" };
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: "unauthorized_client", error_description: "AADSTS700016: Application with identifier 'x' was not found." }),
    };
  }) as unknown as typeof fetch;

  const r = await probeEntraClientCredentials("contoso.com", "app-id", "shh", fake);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "AADSTS700016");
  assert.match(r.hint ?? "", /no application with that app id/i);
  assert.match(seen!.url, /login\.microsoftonline\.com\/contoso\.com\/oauth2\/v2\.0\/token/);
  assert.match(seen!.body, /grant_type=client_credentials/);
  assert.match(seen!.body, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
});

test("the live probe reports success when Entra issues a token", async () => {
  const fake = (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t" }) })) as unknown as typeof fetch;
  assert.deepEqual(await probeEntraClientCredentials("t", "a", "s", fake), { ok: true });
});
