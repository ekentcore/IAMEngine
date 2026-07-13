import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { makeClientRepository } from "./repository";
import { makeCaseRepository } from "../cases/repository";

// The child/parent pair the fakes serve. Only the fields clientForPlanning / copyParentModeling
// actually read.
const PARENT_SYSTEMS = [
  {
    systemKey: "m365", mode: "api", onboardWhen: "always", offboardWhen: "always",
    dependsOn: [] as string[], requiresApproval: false, captureEvidence: false,
    secretNames: ["m365-admin"], config: { onboard: { licenses: ["E3"] } },
  },
];

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child1", name: "Child", slug: "child", primaryDomain: "child.com",
    emailDomain: null, emailDomainLocked: false, serviceNowSysId: null,
    identity: null, personas: null, globals: null, globalsOffboard: null, locations: null,
    systems: [] as unknown[], parentId: "parent1", inheritParentSystems: true,
    ...overrides,
  };
}

function parent() {
  return {
    identity: { usernamePatterns: ["{first}@{domain}"] }, personas: null, globals: null,
    globalsOffboard: null, locations: null, systems: PARENT_SYSTEMS,
  };
}

// Fake db serving client.findUnique by slug (the child) or id (the parent), and recording writes.
function fakeDb(childRow: ReturnType<typeof child>) {
  const writes: { createMany: unknown[]; update: unknown[] } = { createMany: [], update: [] };
  const db = {
    client: {
      findUnique: async (a: { where: { slug?: string; id?: string } }) =>
        a.where.slug ? childRow : a.where.id === "parent1" ? parent() : null,
      update: async (a: { data: unknown }) => { writes.update.push(a.data); },
    },
    clientSystem: {
      createMany: async (a: { data: unknown[] }) => { writes.createMany.push(...a.data); },
    },
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  };
  return { db: db as unknown as PrismaClient, writes };
}

test("clientForPlanning inherits the parent's systems while the link is intact", async () => {
  const { db } = fakeDb(child());
  const c = await makeCaseRepository(db).clientForPlanning("child");
  assert.equal(c?.systems.length, 1);
  assert.equal((c?.identity as { usernamePatterns: string[] }).usernamePatterns[0], "{first}@{domain}");
});

test("clientForPlanning does NOT inherit when inheritParentSystems is false", async () => {
  const { db } = fakeDb(child({ inheritParentSystems: false }));
  const c = await makeCaseRepository(db).clientForPlanning("child");
  assert.equal(c?.systems.length, 0);
  assert.equal(c?.identity, null);
});

test("copyParentModeling copies the parent's systems + null modeling onto the child", async () => {
  const { db, writes } = fakeDb(child());
  const r = await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(r, { ok: true, copied: 1 });
  assert.equal(writes.createMany.length, 1);
  const row = writes.createMany[0] as { clientId: string; systemKey: string; secretNames: string[] };
  assert.equal(row.clientId, "child1");
  assert.equal(row.systemKey, "m365");
  assert.deepEqual(row.secretNames, ["m365-admin"]);
  // identity was null on the child -> filled from the parent; non-null fields aren't in the update
  assert.equal(writes.update.length, 1);
  const data = writes.update[0] as Record<string, unknown>;
  assert.ok(data.identity);
  assert.equal("personas" in data, false); // parent's personas is null — nothing to fill
});

test("copyParentModeling skips systems the child already has and keeps its own modeling", async () => {
  const { db, writes } = fakeDb(child({
    systems: [{ systemKey: "m365" }],
    identity: { usernamePatterns: ["{f}{last}@{domain}"] },
  }));
  const r = await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(r, { ok: true, copied: 0 });
  assert.equal(writes.createMany.length, 0);
  assert.equal(writes.update.length, 0); // child's identity wins — nothing copied over it
});

test("copyParentModeling refuses when there is no parent", async () => {
  const { db } = fakeDb(child({ parentId: null }));
  const r = await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(r, { ok: false, reason: "client has no parent" });
});
