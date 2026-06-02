import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { replanCase } from "./replan-service";

// Minimal fake PrismaClient covering only what replanCase touches for a no-ServiceNow case
// (no network): caseRequest.findUnique (repo.replanInputs), $transaction (repo.replanCaseJobs),
// auditLog.create (repo.writeAudit). A spy records whether jobs were actually replaced.
function fakeDb(caseRow: unknown) {
  const calls = { deleteMany: 0, createMany: 0, update: 0, audit: 0 };
  const db = {
    caseRequest: {
      findUnique: async () => caseRow,
      update: async () => { calls.update++; },
    },
    job: {
      deleteMany: async () => { calls.deleteMany++; },
      createMany: async () => { calls.createMany++; },
    },
    auditLog: { create: async () => { calls.audit++; } },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        job: { deleteMany: async () => { calls.deleteMany++; }, createMany: async () => { calls.createMany++; } },
        caseRequest: { update: async () => { calls.update++; } },
      }),
  };
  return { db: db as unknown as PrismaClient, calls };
}

test("replanCase returns not_found when the case is missing", async () => {
  const { db, calls } = fakeDb(null);
  const res = await replanCase(db, "missing", "test");
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "not_found");
  assert.equal(calls.deleteMany, 0); // nothing mutated
});

test("replanCase refuses once a job has started executing", async () => {
  const { db, calls } = fakeDb({
    serviceNowCaseNumber: null,
    action: "offboard",
    payload: {},
    client: { id: "c1", slug: "acme", primaryDomain: "acme.com", identity: {}, systems: [] },
    jobs: [{ status: "running" }], // execution underway
  });
  const res = await replanCase(db, "case-1", "test");
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "already_started");
  assert.equal(calls.deleteMany, 0); // guard fired before any mutation
  assert.equal(calls.audit, 0);
});

test("replanCase re-plans a not-yet-started case and replaces its jobs", async () => {
  const { db, calls } = fakeDb({
    serviceNowCaseNumber: null, // no SN → no network, no re-pull
    action: "offboard",
    payload: { userPrincipalName: "jane@acme.com" },
    client: { id: "c1", slug: "acme", primaryDomain: "acme.com", identity: {}, systems: [] },
    jobs: [{ status: "pending" }, { status: "manual" }], // planned, not started
  });
  const res = await replanCase(db, "case-1", "test");
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.refreshedFromServiceNow, false);
  assert.equal(calls.deleteMany, 1); // old jobs cleared
  assert.equal(calls.update, 1); // action/payload/status refreshed
  assert.equal(calls.audit, 1); // audited
});
