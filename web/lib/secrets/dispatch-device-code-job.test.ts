import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchDeviceCodeJob } from "./dispatch-device-code-job";

function fakeDb() {
  const created: { case?: any; job?: any } = {};
  return {
    created,
    caseRequest: { create: async ({ data }: any) => { created.case = data; return { id: "case-1" }; } },
    job: { create: async ({ data }: any) => { created.job = data; return { id: "job-1" }; } },
  } as any;
}

test("creates a synthetic onboard case then an entra-devicecode job carrying the userCode + GA secret", async () => {
  const db = fakeDb();
  const r = await dispatchDeviceCodeJob(db, { id: "client-1", slug: "acme", name: "Acme" } as any, "ABCD-EFGH");
  assert.equal(r.jobId, "job-1");
  // synthetic case: onboard, api source, tied to the client
  assert.equal(db.created.case.action, "onboard");
  assert.equal(db.created.case.createdSource, "api");
  assert.equal(db.created.case.clientId, "client-1");
  // job: entra-devicecode, api mode, singleRun, carries userCode + the GA secret
  assert.equal(db.created.job.caseRequestId, "case-1");
  assert.equal(db.created.job.systemKey, "entra-devicecode");
  assert.equal(db.created.job.mode, "api");
  assert.equal(db.created.job.singleRun, true);
  assert.equal(db.created.job.request.config.userCode, "ABCD-EFGH");
  assert.deepEqual(db.created.job.request.secretNames, ["m365-global-admin"]);
  // no gaSecretRef -> no secretOverrides on the synthetic case
  assert.equal(db.created.case.secretOverrides, undefined);
});

test("gaSecretRef provided: the synthetic case's secretOverrides carries it for m365-global-admin", async () => {
  const db = fakeDb();
  await dispatchDeviceCodeJob(db, { id: "client-1", slug: "acme", name: "Acme" } as any, "ABCD-EFGH", "delinea-ext-123");
  assert.deepEqual(db.created.case.secretOverrides, { "m365-global-admin": "delinea-ext-123" });
});

test("gaSecretRef omitted: the synthetic case has no secretOverrides field at all", async () => {
  const db = fakeDb();
  await dispatchDeviceCodeJob(db, { id: "client-1", slug: "acme", name: "Acme" } as any, "ABCD-EFGH");
  assert.ok(!("secretOverrides" in db.created.case));
});
