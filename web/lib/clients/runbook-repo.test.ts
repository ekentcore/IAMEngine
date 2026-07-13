import { test } from "node:test";
import assert from "node:assert/strict";
import { saveRunbook } from "./runbook-repo";
import type { ParsedSection } from "./runbook-parse";

// A minimal stand-in for PrismaClient capturing what saveRunbook writes.
function fakeDb(existingSystems: string[]) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    runbookSection: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    clientSystem: {
      findMany: async () => existingSystems.map((k) => ({ systemKey: k })),
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; },
    },
    systemCatalog: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.map((k) => ({ key: k })),
    },
  };
  const db = {
    client: { findUnique: async () => ({ id: "c1" }) },
    runbookSection: { findFirst: async () => null },
    $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    auditLog: { create: async () => ({}) },
  };
  return { db: db as never, created };
}

const sec = (systemKey: string | null, title: string): ParsedSection =>
  ({ seq: 0, systemKey, title, status: systemKey ? "automated" : "unmodeled", steps: ["step"] });

test("saveRunbook creates missing ClientSystem rows for mapped sections (catalog defaults)", async () => {
  const { db, created } = fakeDb(["m365"]);
  const res = await saveRunbook(db, "core1269", "onboard", "", [
    sec("m365", "Microsoft 365"), sec("mimecast", "Mimecast"), sec(null, "Dashlane"),
  ], "KB0017968");
  assert.deepEqual(res!.createdSystems, ["mimecast"]); // m365 already there, Dashlane unmodeled
  assert.equal(created.length, 1);
  const row = created[0];
  assert.equal(row.systemKey, "mimecast");
  assert.equal(row.mode, "api");
  assert.equal(row.onboardWhen, "always");
  assert.equal(row.offboardWhen, "always");
  assert.deepEqual(row.secretNames, ["mimecast"]);
  assert.deepEqual(row.dependsOn, ["m365"]); // catalog dep kept because the client has m365
});

test("saveRunbook drops catalog deps the client will not have", async () => {
  const { db, created } = fakeDb([]);
  await saveRunbook(db, "x", "onboard", "", [sec("mimecast", "Mimecast")], undefined);
  assert.deepEqual(created[0].dependsOn, []); // depends on m365, which the client lacks
});

test("saveRunbook maps on-request catalog lanes to the db enum", async () => {
  const { db, created } = fakeDb([]);
  await saveRunbook(db, "x", "onboard", "", [sec("zoom", "Zoom")], undefined);
  assert.equal(created[0].onboardWhen, "on_request");
  assert.equal(created[0].offboardWhen, "on_request");
});

test("saveRunbook never touches existing rows", async () => {
  const { db, created } = fakeDb(["m365", "mimecast"]);
  const res = await saveRunbook(db, "x", "onboard", "", [sec("m365", "Microsoft 365"), sec("mimecast", "Mimecast")], undefined);
  assert.deepEqual(res!.createdSystems, []);
  assert.equal(created.length, 0);
});
