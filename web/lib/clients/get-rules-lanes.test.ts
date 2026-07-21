import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { makeClientRepository } from "./repository";

// getRules must expose each system's per-lane inclusion enum (onboardWhen/offboardWhen) as
// `systemLanes`, so the Roles & Rules editor can flag which systems are "by persona" — the ones
// whose inclusion is decided by persona membership. See FR #0000022.

function fakeDb(systems: unknown[]) {
  const db = {
    client: {
      findUnique: async (_a: { where: { slug: string }; select: unknown }) => ({
        id: "c1", personas: null, globals: null, globalsOffboard: null, locations: null,
        adObjects: null, cloudGroups: null, systems,
      }),
    },
  };
  return db as unknown as PrismaClient;
}

test("getRules returns systemLanes with each system's onboard/offboard inclusion enum", async () => {
  const db = fakeDb([
    { systemKey: "active-directory", config: null, onboardWhen: "by_persona", offboardWhen: "always" },
    { systemKey: "m365", config: { onboard: { ou: "OU=Staff" } }, onboardWhen: "always", offboardWhen: "always" },
  ]);
  const rules = await makeClientRepository(db).getRules("cvp");
  assert.ok(rules);
  assert.deepEqual(rules!.systemLanes["active-directory"], { onboard: "by_persona", offboard: "always" });
  assert.deepEqual(rules!.systemLanes["m365"], { onboard: "always", offboard: "always" });
  // systemOnboardOu still works alongside it.
  assert.equal(rules!.systemOnboardOu["m365"], "OU=Staff");
  assert.deepEqual(rules!.systemKeys, ["active-directory", "m365"]);
});

test("getRules returns null for an unknown client", async () => {
  const db = { client: { findUnique: async () => null } } as unknown as PrismaClient;
  assert.equal(await makeClientRepository(db).getRules("nope"), null);
});
