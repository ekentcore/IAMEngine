import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupDeps } from "./setup-m365-deps";

test("buildSetupDeps exposes every SetupDeps key", () => {
  const deps = buildSetupDeps({} as any);
  for (const k of ["startDeviceCode", "pollDeviceCodeToken", "provisionM365App", "writeProvisionedM365App", "hasGlobalAdminSecret", "dispatchDeviceCodeJob", "getJob"]) {
    assert.equal(typeof (deps as any)[k], "function", `missing ${k}`);
  }
});

test("hasGlobalAdminSecret is true only when a m365-global-admin secret row exists", async () => {
  const db = { secret: { findUnique: async ({ where }: any) => where.clientId_name.name === "m365-global-admin" ? { id: "s" } : null } } as any;
  const deps = buildSetupDeps(db);
  assert.equal(await deps.hasGlobalAdminSecret("c1"), true);
});

test("getJob returns the job's status/result/error", async () => {
  const db = { job: { findUnique: async () => ({ status: "succeeded", result: { actions: ["ok"] }, error: null }) } } as any;
  const deps = buildSetupDeps(db);
  assert.deepEqual(await deps.getJob("j1"), { status: "succeeded", result: { actions: ["ok"] }, error: null });
});
