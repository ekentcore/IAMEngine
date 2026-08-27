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
    emailDomain: null, emailDomainLocked: false, serviceNowSysId: null, engineOptOut: false,
    identity: null, personas: null, globals: null, globalsOffboard: null, locations: null,
    systems: [] as unknown[], parentId: "parent1", inheritParentSystems: true, inheritParentModeling: true,
    ...overrides,
  };
}

function parentWithPersonas() {
  return { ...parent(), personas: { vet: {} } };
}

function parent(systems: unknown[] = PARENT_SYSTEMS) {
  return {
    identity: { usernamePatterns: ["{first}@{domain}"] }, personas: null as unknown, globals: null,
    globalsOffboard: null, locations: null, systems,
  };
}

// Fake db serving client.findUnique by slug (the child) or id (the parent), and recording writes.
function fakeDb(childRow: ReturnType<typeof child>, parentRow: ReturnType<typeof parent> = parent()) {
  const writes: { createMany: unknown[]; update: unknown[]; skipDuplicates: boolean[] } = { createMany: [], update: [], skipDuplicates: [] };
  const db = {
    client: {
      findUnique: async (a: { where: { slug?: string; id?: string } }) =>
        a.where.slug ? childRow : a.where.id === "parent1" ? parentRow : null,
      update: async (a: { data: unknown }) => { writes.update.push(a.data); },
    },
    clientSystem: {
      createMany: async (a: { data: unknown[]; skipDuplicates?: boolean }) => {
        writes.createMany.push(...a.data);
        writes.skipDuplicates.push(a.skipDuplicates === true);
      },
    },
    // clientForPlanning also reads the client's (and parent's) secrets to find the ones marked
    // NOT_NEEDED — those systems plan as manual steps. These fixtures wire none.
    secret: { findMany: async () => [] },
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

test("clientForPlanning does NOT inherit SYSTEMS when inheritParentSystems is false", async () => {
  // FR #0000041 split the two: switching off the SYSTEMS link no longer switches off the people
  // rules. A child can legitimately run its own systems while still following the parent's roles,
  // and this test used to assert the old conflated behaviour.
  const { db } = fakeDb(child({ inheritParentSystems: false }));
  const c = await makeCaseRepository(db).clientForPlanning("child");
  assert.equal(c?.systems.length, 0);
  assert.deepEqual(c?.identity, { usernamePatterns: ["{first}@{domain}"] }); // modeling still follows
});

test("clientForPlanning inherits NOTHING when both links are switched off", async () => {
  const { db } = fakeDb(child({ inheritParentSystems: false, inheritParentModeling: false }));
  const c = await makeCaseRepository(db).clientForPlanning("child");
  assert.equal(c?.systems.length, 0);
  assert.equal(c?.identity, null);
});

test("a child with its OWN systems still picks up the parent's roles (FR #0000041)", async () => {
  // core847: five systems of its own and its parent's four personas unreachable, because one gate
  // answered two different questions.
  const { db } = fakeDb(child({ systems: [{ systemKey: "exchange" }] }), parentWithPersonas());
  const c = await makeCaseRepository(db).clientForPlanning("child");
  assert.equal(c?.systems.length, 1);                       // its own, not the parent's
  assert.equal((c?.systems[0] as { systemKey: string }).systemKey, "exchange");
  assert.deepEqual(c?.personas, { vet: {} });               // the parent's roles arrive
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

test("copyParentModeling inserts with skipDuplicates so a double-submit can't 500", async () => {
  const { db, writes } = fakeDb(child());
  await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(writes.skipDuplicates, [true]);
});

// A child with its OWN systems never inherited anything, so copying the parent's in would add
// steps that run against the parent's tenant. Refuse — the caller still breaks the link.
test("copyParentModeling refuses to merge onto a child that already has its own systems", async () => {
  const { db, writes } = fakeDb(child({ systems: [{ systemKey: "google" }] }));
  const r = await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(r, { ok: false, code: "has_own_systems" });
  assert.equal(writes.createMany.length, 0);
  assert.equal(writes.update.length, 0);
});

test("copyParentModeling reports nothing_to_copy when the parent has no systems", async () => {
  const { db, writes } = fakeDb(child(), parent([]));
  const r = await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(r, { ok: false, code: "nothing_to_copy" });
  assert.equal(writes.createMany.length, 0);
});

test("copyParentModeling refuses when there is no parent", async () => {
  const { db } = fakeDb(child({ parentId: null }));
  const r = await makeClientRepository(db).copyParentModeling("child");
  assert.deepEqual(r, { ok: false, code: "no_parent" });
});
