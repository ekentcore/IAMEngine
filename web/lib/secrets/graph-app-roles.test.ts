import { test } from "node:test";
import assert from "node:assert/strict";
import { readGrantedAppRoles, listDisabledLicensedUsers, readMailboxPurpose, graphGet, graphSend } from "./graph-app-roles";

// Exercise the retry PATH without paying its wall clock.
const FAST = { backoff: () => 0 };

const GRAPH_SP = "sp-graph";
const OK = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (status: number) => new Response("nope", { status });

// A tenant whose app has two Graph roles granted.
function tenantFetch(over: { assignments?: Response; graphSp?: () => Response } = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/appRoleAssignments")) {
      return over.assignments
        ? over.assignments.clone()
        : OK({ value: [{ appRoleId: "r1", resourceId: GRAPH_SP }, { appRoleId: "r2", resourceId: GRAPH_SP }] });
    }
    if (u.includes(`/servicePrincipals/${GRAPH_SP}`)) {
      return over.graphSp ? over.graphSp() : OK({ appRoles: [{ id: "r1", value: "User.ReadWrite.All" }, { id: "r2", value: "Group.ReadWrite.All" }] });
    }
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

test("resolves granted app-role GUIDs to names", async () => {
  const { fetch: f } = tenantFetch();
  const r = await readGrantedAppRoles("tok", "app-1", f, FAST);
  assert.deepEqual(r, { ok: true, roles: ["Group.ReadWrite.All", "User.ReadWrite.All"], complete: true, unresolved: 0 });
});

test("an app consented to NOTHING is complete and empty — not an error", () => {
  return (async () => {
    const { fetch: f } = tenantFetch({ assignments: OK({ value: [] }) });
    const r = await readGrantedAppRoles("tok", "app-1", f, FAST);
    assert.deepEqual(r, { ok: true, roles: [], complete: true, unresolved: 0 });
  })();
});

// The PR #90 bug, and the reason this whole module tracks completeness: Graph throttles when a fleet
// sweep reads tenants back-to-back. A dropped role-name lookup used to read as "granted nothing",
// producing a confident, wrong "all permissions missing".
test("a resource-SP read that fails is UNRESOLVED, never 'granted nothing'", async () => {
  const { fetch: f } = tenantFetch({ graphSp: () => ERR(429) });
  const r = await readGrantedAppRoles("tok", "app-1", f, FAST);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roles, []);
  assert.equal(r.complete, false, "an unreadable lookup must not be reported as complete");
  assert.equal(r.unresolved, 2);
});

test("a throttled resource-SP read is retried, and a later success still resolves the names", async () => {
  let n = 0;
  const { fetch: f } = tenantFetch({ graphSp: () => (++n === 1 ? ERR(429) : OK({ appRoles: [{ id: "r1", value: "User.ReadWrite.All" }, { id: "r2", value: "Group.ReadWrite.All" }] })) });
  const r = await readGrantedAppRoles("tok", "app-1", f, FAST);
  assert.equal(r.complete, true);
  assert.deepEqual(r.roles, ["Group.ReadWrite.All", "User.ReadWrite.All"]);
  assert.ok(n > 1, "expected a retry");
});

test("a 403 on our own assignments is 'cannot verify', not 'has nothing'", async () => {
  const { fetch: f } = tenantFetch({ assignments: ERR(403) });
  const r = await readGrantedAppRoles("tok", "app-1", f, FAST);
  assert.equal(r.ok, false, "a denied read must not report ok with an empty role list");
  assert.deepEqual(r.roles, []);
});

test("graphGet does not retry a real answer (403/404), only throttling and 5xx", async () => {
  let n = 0;
  const f = (async () => { n++; return ERR(403); }) as unknown as typeof fetch;
  await graphGet("tok", "/whatever", f, FAST);
  assert.equal(n, 1, "403 is an answer — retrying it just wastes a round trip");
});

test("disabled users with NO licence are not leaks and are filtered out", async () => {
  const f = (async () =>
    OK({
      value: [
        { id: "1", displayName: "Leaver A", userPrincipalName: "a@x.com", assignedLicenses: [{ skuId: "sku-1" }] },
        { id: "2", displayName: "Leaver B", userPrincipalName: "b@x.com", assignedLicenses: [] },
      ],
    })) as unknown as typeof fetch;
  const r = await listDisabledLicensedUsers("tok", f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.users.map((u) => u.userPrincipalName), ["a@x.com"]);
});

test("listDisabledLicensedUsers follows @odata.nextLink", async () => {
  let page = 0;
  const f = (async () => {
    page++;
    return page === 1
      ? OK({ value: [{ id: "1", displayName: "A", userPrincipalName: "a@x.com", assignedLicenses: [{ skuId: "s" }] }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?$skiptoken=2" })
      : OK({ value: [{ id: "2", displayName: "B", userPrincipalName: "b@x.com", assignedLicenses: [{ skuId: "s" }] }] });
  }) as unknown as typeof fetch;
  const r = await listDisabledLicensedUsers("tok", f);
  assert.deepEqual(r.users.map((u) => u.userPrincipalName), ["a@x.com", "b@x.com"]);
});

test("mailbox purpose: 403 means the permission is missing; 404 just means no mailbox", async () => {
  const denied = (async () => ERR(403)) as unknown as typeof fetch;
  assert.deepEqual(await readMailboxPurpose("tok", "u1", denied), { purpose: null, denied: true });
  const noMailbox = (async () => ERR(404)) as unknown as typeof fetch;
  assert.deepEqual(await readMailboxPurpose("tok", "u1", noMailbox), { purpose: null, denied: false });
  const shared = (async () => OK({ userPurpose: "shared" })) as unknown as typeof fetch;
  assert.deepEqual(await readMailboxPurpose("tok", "u1", shared), { purpose: "shared", denied: false });
});

test("graphSend POSTs JSON with the right method/headers/body and returns the parsed body", async () => {
  let seen: { url: string; method?: string; ct?: string; body?: string } | null = null;
  const f = (async (url: string, init?: { method?: string; headers?: Record<string,string>; body?: string }) => {
    seen = { url, method: init?.method, ct: init?.headers?.["Content-Type"], body: init?.body };
    return new Response(JSON.stringify({ id: "new-app" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await graphSend<{ id: string }>("tok", "POST", "/applications", { displayName: "iam-engine" }, f, { backoff: () => 0 });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.body?.id, "new-app");
  assert.equal(seen!.method, "POST");
  assert.equal(seen!.ct, "application/json");
  assert.equal(seen!.url, "https://graph.microsoft.com/v1.0/applications");
  assert.deepEqual(JSON.parse(seen!.body!), { displayName: "iam-engine" });
});

test("graphSend returns ok with null body on a 204", async () => {
  const f = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const r = await graphSend("tok", "POST", "/x", {}, f, { backoff: () => 0 });
  assert.equal(r.ok && r.body === null, true);
});

test("graphSend surfaces a non-retryable error with status + text", async () => {
  const f = (async () => new Response("Insufficient privileges", { status: 403 })) as unknown as typeof fetch;
  const r = await graphSend("tok", "POST", "/x", {}, f, { backoff: () => 0 });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 403);
  assert.match((!r.ok && r.error) || "", /Insufficient/);
});

// Fix D: a lost response (network/timeout) after a POST must NOT be retried — the write may already
// have landed, and POST (e.g. addPassword, appRoleAssignedTo) is not idempotent. Retrying risks
// double-creating.
test("graphSend: a POST that throws (status 0) is attempted exactly once, not retried", async () => {
  let n = 0;
  const f = (async () => { n++; throw new Error("network drop"); }) as unknown as typeof fetch;
  const r = await graphSend("tok", "POST", "/servicePrincipals/x/appRoleAssignedTo", {}, f, { backoff: () => 0 });
  assert.equal(r.ok, false);
  assert.equal(n, 1, "a non-idempotent POST must not be retried on a lost response");
});

test("graphSend: a PATCH that throws once then succeeds IS retried (idempotent)", async () => {
  let n = 0;
  const f = (async () => {
    n++;
    if (n === 1) throw new Error("network drop");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await graphSend("tok", "PATCH", "/applications/x", {}, f, { backoff: () => 0 });
  assert.equal(r.ok, true);
  assert.ok(n > 1, "expected a retry for the idempotent PATCH");
});

test("graphSend: a POST does not retry a 500, but a PATCH does", async () => {
  let postAttempts = 0;
  const postF = (async () => { postAttempts++; return new Response("boom", { status: 500 }); }) as unknown as typeof fetch;
  const postR = await graphSend("tok", "POST", "/x", {}, postF, { backoff: () => 0 });
  assert.equal(postR.ok, false);
  assert.equal(postAttempts, 1, "a POST must not retry a 5xx (ambiguous, non-idempotent)");

  let patchAttempts = 0;
  const patchF = (async () => { patchAttempts++; return new Response("boom", { status: 500 }); }) as unknown as typeof fetch;
  await graphSend("tok", "PATCH", "/x", {}, patchF, { backoff: () => 0, maxAttempts: 2 });
  assert.equal(patchAttempts, 2, "a PATCH should retry a 5xx");
});

test("graphSend: 429 is retried regardless of method (POST included)", async () => {
  let n = 0;
  const f = (async () => {
    n++;
    if (n === 1) return new Response("throttled", { status: 429 });
    return new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await graphSend("tok", "POST", "/x", {}, f, { backoff: () => 0 });
  assert.equal(r.ok, true);
  assert.ok(n > 1, "429 must be retried even for POST — a rejected request never reached the server logic");
});
