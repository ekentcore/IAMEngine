import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { replanCase } from "./replan-service";

// Minimal fake PrismaClient covering only what replanCase touches for a no-ServiceNow case
// (no network): caseRequest.findUnique (repo.replanInputs), $transaction (repo.replanCaseJobs),
// auditLog.create (repo.writeAudit). `keptJobs` = the started jobs that survive the conditional
// delete inside the transaction ([] = classic full replace; non-empty = INCREMENTAL replan that
// keeps them and adds only systems without a kept job).
function fakeDb(caseRow: unknown, keptJobs: unknown[] = []) {
  const calls = { deleteMany: 0, createMany: 0, create: 0, jobUpdate: 0, delete: 0, update: 0, audit: 0 };
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
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
    // repo.replanInputs reads the client's secrets to find the ones marked NOT_NEEDED (those systems
    // plan as manual steps). None of these fixtures wire secrets, so an empty set is the right answer.
    secret: { findMany: async () => [] },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        job: {
          deleteMany: async () => { calls.deleteMany++; },
          createMany: async () => { calls.createMany++; },
          create: async (a: { data: Record<string, unknown> }) => { calls.create++; created.push(a.data); },
          update: async (a: { data: Record<string, unknown> }) => { calls.jobUpdate++; updated.push(a.data); },
          delete: async () => { calls.delete++; },
          findMany: async () => keptJobs,
        },
        caseRequest: { findUnique: async () => caseRow, update: async () => { calls.update++; } },
      }),
  };
  return { db: db as unknown as PrismaClient, calls, created, updated };
}

// A minimal ClientSystem fixture (only the fields planCase reads).
function sys(systemKey: string, config: unknown) {
  return {
    systemKey, mode: "api", onboardWhen: "always", offboardWhen: "always",
    dependsOn: [] as string[], requiresApproval: false, captureEvidence: false,
    secretNames: [] as string[], config,
  };
}

test("replanCase returns not_found when the case is missing", async () => {
  const { db, calls } = fakeDb(null);
  const res = await replanCase(db, "missing", "test");
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "not_found");
  assert.equal(calls.deleteMany, 0); // nothing mutated
});

test("replanCase on a STARTED case runs incrementally: kept jobs survive, nothing is lost", async () => {
  const kept = [{ id: "j1", systemKey: "m365", sequence: 0, mode: "api", status: "running", request: {} }];
  const { db, calls } = fakeDb({
    serviceNowCaseNumber: null,
    action: "offboard",
    payload: {},
    client: { id: "c1", slug: "acme", primaryDomain: "acme.com", identity: {}, systems: [] },
    jobs: [{ status: "running" }], // execution underway
  }, kept);
  const res = await replanCase(db, "case-1", "test");
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.mode, "incremental");
  assert.equal(res.ok === true && res.kept, 1);
  assert.equal(res.ok === true && res.added, 0); // no systems -> nothing new to add
  assert.equal(calls.createMany, 0);
  assert.equal(calls.audit, 1);
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
  assert.equal(res.ok === true && res.mode, "full");
  assert.equal(calls.deleteMany, 1); // old jobs cleared
  assert.equal(calls.update, 1); // action/payload/status refreshed
  assert.equal(calls.audit, 1); // audited
});

test("a job claimed in the TOCTOU window flips the replan to incremental instead of failing", async () => {
  // Pre-check saw only pending jobs, but inside the tx the conditional delete leaves a started
  // survivor (a runner claimed it concurrently) → that job is KEPT and the replan degrades to
  // incremental — no rollback, no lost work.
  const { db } = fakeDb(
    {
      serviceNowCaseNumber: null,
      action: "offboard",
      payload: {},
      client: { id: "c1", slug: "acme", primaryDomain: "acme.com", identity: {}, systems: [] },
      jobs: [{ status: "pending" }], // pre-check passes
    },
    [{ id: "j1", systemKey: "m365", sequence: 0, mode: "api", status: "running", request: {} }]
  );
  const res = await replanCase(db, "case-1", "test");
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.mode, "incremental");
  assert.equal(res.ok === true && res.kept, 1);
});

test("replan RE-RUNS a kept api step whose config changed (e.g. a new license)", async () => {
  const kept = [{ id: "j1", systemKey: "m365", sequence: 5, mode: "api", status: "succeeded", request: { config: { licenses: ["E1"] } } }];
  const { db, updated } = fakeDb({
    serviceNowCaseNumber: null, action: "onboard", payload: { userPrincipalName: "jane@acme.com" },
    client: { id: "c1", slug: "acme", primaryDomain: "acme.com", identity: {}, systems: [sys("m365", { onboard: { licenses: ["E3"] } })] },
    jobs: [{ status: "succeeded" }],
  }, kept);
  const res = await replanCase(db, "case-1", "test");
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.rerun, 1);
  assert.ok(updated.find((u) => u.status === "pending"), "changed step reset to pending to re-run");
});

test("replan re-sequences a kept step to its planned position and does NOT re-run when config is unchanged", async () => {
  const kept = [{ id: "j1", systemKey: "m365", sequence: 9, mode: "api", status: "succeeded", request: { config: { licenses: ["E3"] } } }];
  const { db, updated } = fakeDb({
    serviceNowCaseNumber: null, action: "onboard", payload: {},
    client: { id: "c1", slug: "acme", primaryDomain: "acme.com", identity: {}, systems: [sys("m365", { onboard: { licenses: ["E3"] } })] },
    jobs: [{ status: "succeeded" }],
  }, kept);
  const res = await replanCase(db, "case-1", "test");
  assert.equal(res.ok, true);
  assert.equal(res.ok === true && res.rerun, 0);
  assert.ok(updated.find((u) => u.sequence === 0), "kept step re-sequenced to planned order (was 9 -> 0)");
});
