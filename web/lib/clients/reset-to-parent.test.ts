import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { makeClientRepository } from "./repository";

// FR #0000023 — resetToParent reverts a child back to inheriting from its parent. Whole-child clears
// the child's own systems (+ dependent state) and modeling and restores inheritParentSystems; "full"
// also deletes the child's own Secret rows. Per-system OVERWRITES one system with the parent's version
// (because systems inheritance is all-or-nothing). These tests use a fake db recording the writes.

type Where = { clientId?: string; systemKey?: string; name?: { in: string[] } };

function fakeDb(opts: {
  client: { id: string; parentId: string | null; systems: { systemKey: string; secretNames: string[] }[] } | null;
  parentSystem?: Record<string, unknown> | null;
  counts?: { systems?: number; secrets?: number };
}) {
  const del: [string, Where][] = [];
  const upserts: { where: unknown; update: unknown; create: unknown }[] = [];
  const clientUpdates: { data: Record<string, unknown> }[] = [];
  const mkDel = (name: string, count = 0) => async (a: { where: Where }) => { del.push([name, a.where]); return { count }; };
  const tx = {
    systemSetupState: { deleteMany: mkDel("systemSetupState") },
    connHealthState: { deleteMany: mkDel("connHealthState") },
    connectionTest: { deleteMany: mkDel("connectionTest") },
    clientSystem: {
      deleteMany: mkDel("clientSystem", opts.counts?.systems ?? 0),
      upsert: async (a: { where: unknown; update: unknown; create: unknown }) => { upserts.push(a); return {}; },
    },
    secret: { deleteMany: mkDel("secret", opts.counts?.secrets ?? 0) },
    client: { update: async (a: { data: Record<string, unknown> }) => { clientUpdates.push(a); return {}; } },
  };
  const db = {
    client: { findUnique: async () => opts.client },
    clientSystem: { findUnique: async () => opts.parentSystem ?? null },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { db: db as unknown as PrismaClient, del, upserts, clientUpdates };
}

const child = (systems: { systemKey: string; secretNames: string[] }[] = [{ systemKey: "m365", secretNames: ["m365-admin"] }]) =>
  ({ id: "child1", parentId: "parent1", systems });

test("whole-child full: deletes systems+state+secrets, nulls modeling, restores inheritance", async () => {
  const { db, del, clientUpdates } = fakeDb({ client: child(), counts: { systems: 2, secrets: 3 } });
  const r = await makeClientRepository(db).resetToParent("kid", { scope: "full" });
  assert.deepEqual(r, { ok: true, removedSystems: 2, removedSecrets: 3, copiedSystem: false });
  const tables = del.map((d) => d[0]);
  assert.ok(tables.includes("clientSystem") && tables.includes("systemSetupState") && tables.includes("connHealthState") && tables.includes("connectionTest") && tables.includes("secret"));
  // Secrets cleared for the whole child (no name filter).
  const secretDel = del.find((d) => d[0] === "secret")![1];
  assert.equal(secretDel.clientId, "child1");
  assert.equal(secretDel.name, undefined);
  // Modeling nulled + inheritance restored.
  const data = clientUpdates[0].data;
  assert.equal(data.inheritParentSystems, true);
  for (const k of ["identity", "personas", "globals", "globalsOffboard", "locations"]) assert.ok(k in data);
});

test("whole-child systems-only: keeps the child's Secret rows", async () => {
  const { db, del, clientUpdates } = fakeDb({ client: child(), counts: { systems: 1 } });
  const r = await makeClientRepository(db).resetToParent("kid", { scope: "systems" });
  assert.equal(r.ok, true);
  assert.equal((r as { removedSecrets: number }).removedSecrets, 0);
  assert.ok(!del.some((d) => d[0] === "secret")); // no secret deletion
  assert.equal(clientUpdates[0].data.inheritParentSystems, true); // still restores inheritance + modeling
});

test("per-system: overwrites the child's system with the parent's version (no delete)", async () => {
  const parentSystem = { mode: "api", onboardWhen: "always", offboardWhen: "always", dependsOn: [], requiresApproval: false, captureEvidence: false, secretNames: ["m365-admin"], config: { onboard: {} } };
  const { db, del, upserts, clientUpdates } = fakeDb({ client: child(), parentSystem });
  const r = await makeClientRepository(db).resetToParent("kid", { scope: "full", systemKey: "m365" });
  assert.equal(r.ok, true);
  assert.equal((r as { copiedSystem: boolean }).copiedSystem, true);
  assert.equal(upserts.length, 1); // overwrote, did not delete the ClientSystem row
  assert.ok(!del.some((d) => d[0] === "clientSystem"));
  // Dependent state for the one key was cleared.
  for (const t of ["systemSetupState", "connHealthState", "connectionTest"]) {
    const e = del.find((d) => d[0] === t)!;
    assert.equal(e[1].systemKey, "m365");
  }
  // scope full deletes the child's secrets named by THIS system only.
  const secretDel = del.find((d) => d[0] === "secret")!;
  assert.deepEqual(secretDel[1].name, { in: ["m365-admin"] });
  assert.equal(clientUpdates.length, 0); // per-system does not touch modeling/inheritance
});

test("per-system where the parent lacks the system: deletes the child's override", async () => {
  const { db, del, upserts } = fakeDb({ client: child(), parentSystem: null, counts: { systems: 1 } });
  const r = await makeClientRepository(db).resetToParent("kid", { scope: "systems", systemKey: "m365" });
  assert.equal((r as { copiedSystem: boolean }).copiedSystem, false);
  assert.equal((r as { removedSystems: number }).removedSystems, 1);
  assert.equal(upserts.length, 0);
  assert.ok(del.some((d) => d[0] === "clientSystem" && d[1].systemKey === "m365"));
});

test("a client with no parent is refused, nothing deleted", async () => {
  const { db, del } = fakeDb({ client: { id: "x", parentId: null, systems: [] } });
  const r = await makeClientRepository(db).resetToParent("x", { scope: "full" });
  assert.deepEqual(r, { ok: false, code: "no_parent" });
  assert.equal(del.length, 0);
});

test("an unknown client is not found", async () => {
  const { db } = fakeDb({ client: null });
  assert.deepEqual(await makeClientRepository(db).resetToParent("nope", { scope: "full" }), { ok: false, code: "not_found" });
});
