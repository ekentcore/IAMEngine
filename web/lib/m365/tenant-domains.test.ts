import { test } from "node:test";
import assert from "node:assert/strict";
import { listTenantDomains } from "./tenant-domains";

const fetcher = (graph: { status?: number; body?: unknown }) => (async (url: string) => {
  if (String(url).includes("login.microsoftonline.com")) {
    return { ok: true, status: 200, json: async () => ({ access_token: "tok" }) } as Response;
  }
  const status = graph.status ?? 200;
  return { ok: status < 300, status, json: async () => graph.body ?? {} } as Response;
}) as typeof fetch;

test("returns verified, non-onmicrosoft domains lowercase", async () => {
  const r = await listTenantDomains("t", "app", "sec", fetcher({ body: { value: [
    { id: "DCG.co", isDefault: true, isVerified: true },
    { id: "grayscale.com", isDefault: false, isVerified: true },
    { id: "dcg.onmicrosoft.com", isDefault: false, isVerified: true },
    { id: "pending.com", isDefault: false, isVerified: false },
  ] } }));
  assert.ok(r.ok && r.ok === true);
  assert.deepEqual(r.ok && r.domains.map((d) => d.name), ["dcg.co", "grayscale.com"]);
});

test("403 from Graph is the actionable Domain.Read.All message", async () => {
  const r = await listTenantDomains("t", "app", "sec", fetcher({ status: 403 }));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /Domain\.Read\.All/);
});
