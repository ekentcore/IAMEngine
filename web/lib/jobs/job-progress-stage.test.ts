import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { makeRunnerService } from "./runner-service";

// recordProgress writes two independent live signals: a free-text `phase` (appended to the narration
// trail shown in the run report) and a coarse `stage` (a SCALAR column the guided-setup run checklist
// reads to advance). These pin that they land in the right place and never bleed into each other.
function stubDb(job: Record<string, unknown> | null) {
  const calls: { update?: Record<string, unknown>; agentUpdated?: boolean } = {};
  const db = {
    job: {
      findUnique: async () => job,
      update: async (args: { data: Record<string, unknown> }) => { calls.update = args.data; return {}; },
    },
    agent: { update: async () => { calls.agentUpdated = true; return {}; } },
  } as unknown as PrismaClient;
  return { db, calls };
}

const running = { status: "running", assignedAgentId: "a1", progress: [{ ts: "t0", phase: "connecting" }] };

test("a stage-only post sets Job.stage and does NOT touch the narration trail", async () => {
  const { db, calls } = stubDb({ ...running });
  const r = await makeRunnerService(db).recordProgress("j1", "a1", undefined, "create");
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.update?.stage, "create");
  assert.equal(calls.update?.progress, undefined); // trail untouched
  assert.equal(calls.update?.status, "running");
  assert.ok(calls.update?.progressAt instanceof Date);
});

test("a phase-only post appends to the trail and leaves stage untouched", async () => {
  const { db, calls } = stubDb({ ...running });
  await makeRunnerService(db).recordProgress("j1", "a1", "enabling mailbox");
  const trail = calls.update?.progress as { phase: string }[];
  assert.equal(trail.length, 2);
  assert.equal(trail[1].phase, "enabling mailbox");
  assert.equal(calls.update?.stage, undefined);
});

test("a post carrying both a phase and a stage writes both", async () => {
  const { db, calls } = stubDb({ ...running });
  await makeRunnerService(db).recordProgress("j1", "a1", "generating credential", "harvest");
  assert.equal(calls.update?.stage, "harvest");
  assert.equal((calls.update?.progress as unknown[]).length, 2);
});

test("stage is capped at 40 chars (defends the scalar column against a runaway marker)", async () => {
  const { db, calls } = stubDb({ ...running });
  await makeRunnerService(db).recordProgress("j1", "a1", undefined, "x".repeat(100));
  assert.equal((calls.update?.stage as string).length, 40);
});

test("a post to an already-terminal job is dropped (no write), not an error", async () => {
  const { db, calls } = stubDb({ status: "succeeded", assignedAgentId: "a1", progress: [] });
  const r = await makeRunnerService(db).recordProgress("j1", "a1", undefined, "vault");
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.update, undefined);
});
