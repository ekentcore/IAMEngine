import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertProbeHost,
  fieldCI,
  isPrivateAddress,
  probeAuthHeaders,
  probeVerdict,
  resolveSecretTemplates,
  runProbe,
  splitSafeOps,
  type ProbeFetcher,
  type ProbeOpResult,
} from "./probe";
import type { ImportedOperation } from "./import-har";

const op = (over: Partial<ImportedOperation>): ImportedOperation => ({
  suggestedName: "get-users", method: "GET", host: "api.vendor.com", path: "/v1/users", headers: {}, body: null, responseStatus: 200, strippedAuthHeaders: [], ...over,
});

const respond = (status: number, contentType = "application/json"): ReturnType<ProbeFetcher> =>
  Promise.resolve({ status, headers: { get: (n: string) => (n === "content-type" ? contentType : null) } });

// ── field lookup mirrors the runner ─────────────────────────────────────────
// Delinea spells fields "Username"/"Password"; the runner reads them case-insensitively via PSObject
// property lookup. A case-sensitive probe would fail a credential the published connector accepts.

test("fieldCI finds Delinea's capitalized field names", () => {
  assert.equal(fieldCI({ Password: "s3cret", Username: "app-id" }, "password"), "s3cret");
  assert.equal(fieldCI({ Password: "x" }, "missing"), undefined);
});

test("bearer auth uses the password field, exactly like the runner", async () => {
  const r = await probeAuthHeaders({ type: "bearer", secretName: "api" }, { Password: "tok" });
  assert.deepEqual(r, { headers: { Authorization: "Bearer tok" } });
});

test("bearer auth without a password field reports the same gap a published connector would hit", async () => {
  const r = await probeAuthHeaders({ type: "bearer", secretName: "api" }, { Username: "only" });
  assert.match((r as { error: string }).error, /no password field/);
});

test("basic auth base64s username:password", async () => {
  const r = await probeAuthHeaders({ type: "basic", secretName: "api" }, { Username: "u", Password: "p" });
  assert.deepEqual(r, { headers: { Authorization: `Basic ${Buffer.from("u:p").toString("base64")}` } });
});

test("header auth resolves {{secret.<name>.<field>}} in the valueTemplate", async () => {
  const r = await probeAuthHeaders(
    { type: "header", secretName: "vendor", header: "X-Api-Key", valueTemplate: "key {{secret.vendor.Api Key}}" },
    { "API KEY": "abc123" }
  );
  assert.deepEqual(r, { headers: { "X-Api-Key": "key abc123" } });
});

test("header auth names the template it cannot resolve rather than sending a literal {{...}}", async () => {
  const r = await probeAuthHeaders(
    { type: "header", secretName: "vendor", header: "X-K", valueTemplate: "{{secret.vendor.token}}" },
    { Password: "x" }
  );
  assert.match((r as { error: string }).error, /\{\{secret\.vendor\.token\}\}/);
});

test("oauth2 posts a client-credentials grant and turns access_token into a bearer", async () => {
  let seen: { url?: string; body?: string } = {};
  const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(url), body: String(init?.body) };
    return new Response(JSON.stringify({ access_token: "granted" }), { status: 200 });
  }) as typeof fetch;
  const r = await probeAuthHeaders(
    { type: "oauth2-client-credentials", secretName: "api", tokenUrl: "https://login.vendor.com/token", scope: "read" },
    { Username: "cid", Password: "cs" },
    fake
  );
  assert.deepEqual(r, { headers: { Authorization: "Bearer granted" } });
  assert.equal(seen.url, "https://login.vendor.com/token");
  assert.match(seen.body ?? "", /grant_type=client_credentials/);
  assert.match(seen.body ?? "", /scope=read/);
});

test("oauth2 token rejection surfaces the status, not a crash", async () => {
  const fake = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  const r = await probeAuthHeaders({ type: "oauth2-client-credentials", secretName: "api", tokenUrl: "https://l.v.com/t" }, { Username: "a", Password: "b" }, fake);
  assert.match((r as { error: string }).error, /HTTP 401/);
});

test("auth type none needs no credential and sends no auth header", async () => {
  assert.deepEqual(await probeAuthHeaders({ type: "none" }, {}), { headers: {} });
});

// ── only reads are replayed ─────────────────────────────────────────────────
// The HAR was captured doing a REAL task; its POST/DELETE calls did something once already.

test("splitSafeOps drops every write and names what it dropped", () => {
  const { safe, skippedUnsafe } = splitSafeOps([
    op({ method: "GET", suggestedName: "get-users" }),
    op({ method: "POST", suggestedName: "create-user" }),
    op({ method: "DELETE", suggestedName: "delete-user" }),
    op({ method: "HEAD", suggestedName: "head-ping" }),
  ]);
  assert.deepEqual(safe.map((o) => o.name), ["get-users", "head-ping"]);
  assert.deepEqual(skippedUnsafe, ["POST create-user", "DELETE delete-user"]);
});

// ── the private-network guard ───────────────────────────────────────────────
// The probe runs on the app server before any allowlist exists; pointed inward it would be a
// network scanner with a credential attached.

test("private and loopback addresses are recognized in v4, v6 and v4-mapped forms", () => {
  for (const a of ["10.0.0.5", "127.0.0.1", "192.168.0.11", "172.16.9.1", "169.254.1.1", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
});

test("a literal IP is refused before any DNS lookup", async () => {
  await assert.rejects(assertProbeHost("192.168.0.11", async () => ["192.168.0.11"]), /literal IP/);
  await assert.rejects(assertProbeHost("2606:4700::1111", /* v6 literal */ async () => []), /not a valid hostname|literal IP/);
});

test("local-sounding names are refused outright", async () => {
  for (const h of ["localhost", "db.local", "vault.internal"]) {
    await assert.rejects(assertProbeHost(h, async () => ["8.8.8.8"]), /local/);
  }
});

test("a public name that resolves into private space is refused — the CNAME trick", async () => {
  await assert.rejects(assertProbeHost("api.vendor.com", async () => ["8.8.8.8", "10.0.0.9"]), /private address \(10\.0\.0\.9\)/);
});

test("a public name resolving publicly passes", async () => {
  await assert.doesNotReject(assertProbeHost("api.vendor.com", async () => ["8.8.8.8"]));
});

test("an unresolvable host is reported as such, not as a transport mystery later", async () => {
  await assert.rejects(assertProbeHost("gone.example", async () => { throw new Error("ENOTFOUND"); }), /did not resolve/);
});

// ── the replay ──────────────────────────────────────────────────────────────

test("runProbe classifies statuses and never lets an op header override the auth header", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: ProbeFetcher = (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.includes("/ok")) return respond(200);
    if (url.includes("/denied")) return respond(401);
    if (url.includes("/bounce")) return respond(302, "text/html");
    return Promise.reject(new Error("socket hang up"));
  };
  const results = await runProbe(
    [
      { name: "a", method: "GET", host: "api.v.com", path: "/ok", headers: { accept: "application/json", authorization: "Bearer PASTED" } },
      { name: "b", method: "GET", host: "api.v.com", path: "/denied", headers: {} },
      { name: "c", method: "GET", host: "api.v.com", path: "/bounce", headers: {} },
      { name: "d", method: "GET", host: "api.v.com", path: "/dead", headers: {} },
    ],
    { authorization: "Bearer REAL" },
    fetcher
  );
  assert.deepEqual(results.map((r) => [r.name, r.status, r.ok, r.authRejected, r.redirected]), [
    ["a", 200, true, false, false],
    ["b", 401, false, true, false],
    ["c", 302, false, false, true],
    ["d", null, false, false, false],
  ]);
  assert.equal(results[3].error, "socket hang up");
  // The auth block always wins over anything left in a captured header.
  assert.equal(calls[0].headers.authorization, "Bearer REAL");
  assert.equal(results[2].contentType, "text/html");
});

// ── the verdict is the product ──────────────────────────────────────────────

const res = (over: Partial<ProbeOpResult>): ProbeOpResult => ({
  name: "x", method: "GET", host: "h", path: "/p", status: 200, ok: true, authRejected: false, redirected: false, ...over,
});

test("all-2xx reads as a usable private API", () => {
  assert.equal(probeVerdict([res({}), res({})]).verdict, "usable");
});

test("all-rejected (401s and login redirects alike) reads as session-auth — the browser-lane answer", () => {
  const v = probeVerdict([res({ status: 401, ok: false, authRejected: true }), res({ status: 302, ok: false, redirected: true })]);
  assert.equal(v.verdict, "auth-rejected");
  assert.match(v.note, /browser/);
});

test("a mix of accepted and rejected is called mixed, not success", () => {
  assert.equal(probeVerdict([res({}), res({ status: 401, ok: false, authRejected: true })]).verdict, "mixed");
});

test("nothing answering is unreachable; an all-writes capture is nothing-probed", () => {
  assert.equal(probeVerdict([res({ status: null, ok: false })]).verdict, "unreachable");
  assert.equal(probeVerdict([]).verdict, "nothing-probed");
});
