import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { requeueJob } from "./requeue";

// Stub Prisma client — just enough surface for requeueJob. `updateCount` simulates the optimistic
// write outcome; captured args let the tests assert what was written and what guarded the write.
function stubDb(job: Record<string, unknown> | null, opts: { updateCount?: number } = {}) {
  const calls: { jobWhere?: Record<string, unknown>; jobUpdate?: Record<string, unknown>; caseUpdate?: boolean; auditDetail?: unknown; reads?: number } = { reads: 0 };
  const db = {
    job: {
      findUnique: async () => { calls.reads = (calls.reads ?? 0) + 1; return job; },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.jobWhere = args.where;
        calls.jobUpdate = args.data;
        return { count: opts.updateCount ?? 1 };
      },
    },
    caseRequest: { update: async () => { calls.caseUpdate = true; return {}; } },
    auditLog: { create: async (args: { data: { detail?: unknown } }) => { calls.auditDetail = args.data.detail; return {}; } },
  } as unknown as PrismaClient;
  return { db, calls };
}

const actor = "ui";

test("a finished job re-queues normally, guarded by the status it was read at", async () => {
  const { db, calls } = stubDb({ id: "j1", mode: "api", status: "succeeded", caseRequestId: "c1", request: { validateOnly: true, priorStatus: "succeeded", priorError: "x", priorValidation: { ok: true } } });
  const r = await requeueJob(db, "j1", actor);
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.jobUpdate?.status, "pending");
  // The optimistic-concurrency guard IS the fix — the write must be conditional on the read status.
  assert.deepEqual(calls.jobWhere, { id: "j1", status: "succeeded" });
  // A re-run is a FULL run — the verify stamps must not survive into the fresh request.
  const req = calls.jobUpdate?.request as Record<string, unknown>;
  assert.equal(req.validateOnly, undefined);
  assert.equal(req.priorStatus, undefined);
  assert.equal(req.priorError, undefined);
  assert.equal(req.priorValidation, undefined);
  assert.equal(calls.caseUpdate, true);
});

// The auto-verify race: the sweep reset this job to a PENDING validate-only pass the instant the case
// completed — exactly when the operator answered a picker that re-queues it. Converting the queued
// verify into the full re-run is the answer being honored; a 409 was the answer being dropped.
test("a queued (pending, unclaimed) verify job converts into the full re-run instead of 409", async () => {
  const { db, calls } = stubDb({ id: "j1", mode: "api", status: "pending", caseRequestId: "c1", request: { validateOnly: true, config: { x: 1 } } });
  const r = await requeueJob(db, "j1", actor);
  assert.deepEqual(r, { ok: true });
  assert.equal((calls.jobUpdate?.request as Record<string, unknown>).validateOnly, undefined);
  assert.deepEqual(calls.jobWhere, { id: "j1", status: "pending" });
});

// Already queued for a full run = the state a re-queue produces. Refusing it made the
// mailbox-decision retry fail forever once the first attempt had converted the job.
test("a pending job that is already a full run is an idempotent success (no row touched)", async () => {
  const { db, calls } = stubDb({ id: "j1", mode: "api", status: "pending", caseRequestId: "c1", request: {} });
  const r = await requeueJob(db, "j1", actor);
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.jobUpdate, undefined, "the job row must not be rewritten");
  assert.equal(calls.caseUpdate, true, "the case is still reopened so the claim loop runs it");
  assert.deepEqual(calls.auditDetail, { alreadyQueued: true });
});

test("in-flight statuses (dispatched/running) still refuse", async () => {
  for (const status of ["dispatched", "running"]) {
    const { db } = stubDb({ id: "j1", mode: "api", status, caseRequestId: "c1", request: { validateOnly: true } });
    const r = await requeueJob(db, "j1", actor);
    assert.equal(r.ok, false, status);
    if (!r.ok) assert.equal(r.status, 409);
  }
});

test("a persistent write conflict re-reads once, then reports a retryable 409", async () => {
  const { db, calls } = stubDb({ id: "j1", mode: "api", status: "pending", caseRequestId: "c1", request: { validateOnly: true } }, { updateCount: 0 });
  const r = await requeueJob(db, "j1", actor);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.match(r.error, /try again/i);
  }
  assert.equal(calls.reads, 2, "one re-read before giving up");
});

test("manual jobs are refused with 422", async () => {
  const { db } = stubDb({ id: "j1", mode: "manual", status: "manual", caseRequestId: "c1", request: {} });
  const r = await requeueJob(db, "j1", actor);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 422);
});
