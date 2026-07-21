import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAndWire } from "./verify-and-wire";

function fakeDb(existingFields: Record<string, string>) {
  const calls: { upsert: unknown[] } = { upsert: [] };
  const db = {
    secret: { findMany: async () => [], upsert: async (a: unknown) => { calls.upsert.push(a); return {}; } },
    clientSystem: { findMany: async () => [] }, systemSetupState: { updateMany: async () => {} },
    auditLog: { create: async () => {} }, $transaction: async (o: Promise<unknown>[]) => Promise.all(o),
    client: { update: async () => {} },
  } as never;
  return { db, calls };
}
// resolveSecretFields is injected for the test.
test("verifyAndWire: passing probe -> wires the id + label", async () => {
  const { db, calls } = fakeDb({ ClientId: "cid", ClientSecret: "sec" });
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "mimecast", externalId: "12345", label: "Mimecast (auto)",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "u", DELINEA_PASSWORD: "p" },
    resolveFields: async () => ({ ok: true, fields: { ClientId: "cid", ClientSecret: "sec" } }),
    fetcher: (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "t" }) })) as never,
  });
  assert.equal(r.ok, true); assert.equal(r.wired, true); assert.equal(calls.upsert.length, 1);
});
test("verifyAndWire: failing blocking probe -> does NOT wire", async () => {
  const { db, calls } = fakeDb({});
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "mimecast", externalId: "12345",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "u", DELINEA_PASSWORD: "p" },
    resolveFields: async () => ({ ok: true, fields: { ClientId: "cid", ClientSecret: "bad" } }),
    fetcher: (async () => ({ ok: false, status: 401, json: async () => ({ error: "invalid_client" }) })) as never,
  });
  assert.equal(r.ok, false); assert.equal(calls.upsert.length, 0);
});
test("verifyAndWire: unprobeable (unregistered) name -> still wires", async () => {
  const { db, calls } = fakeDb({});
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "totally-unregistered", externalId: "12345",
    resolveFields: async () => ({ ok: true, fields: { Username: "u", Password: "p" } }),
  });
  assert.equal(r.ok, true); assert.equal(r.wired, true); assert.equal(calls.upsert.length, 1);
});
test("verifyAndWire: can't resolve the secret -> error, no wire", async () => {
  const { db, calls } = fakeDb({});
  const r = await verifyAndWire({
    db, slug: "acme", clientId: "c1", name: "mimecast", externalId: "999",
    env: { DELINEA_BASE_URL: "https://x", DELINEA_USER: "u", DELINEA_PASSWORD: "p" },
    resolveFields: async () => ({ ok: false, error: "not found in Delinea" }),
    fetcher: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
  });
  assert.equal(r.ok, false); assert.match(r.error ?? "", /not found/); assert.equal(calls.upsert.length, 0);
});
