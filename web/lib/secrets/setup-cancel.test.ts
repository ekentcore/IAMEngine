import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSetupRun, releaseSetupRun, abortSetupRun, setupRunRegistered, stopAutoSetupJobs } from "./setup-cancel";

test("register -> abort fires the signal and clears the registry entry", () => {
  const signal = registerSetupRun("m365", "run-a");
  assert.equal(signal.aborted, false);
  assert.equal(setupRunRegistered("m365", "run-a"), true);
  assert.equal(abortSetupRun("m365", "run-a"), true);
  assert.equal(signal.aborted, true);
  assert.equal(setupRunRegistered("m365", "run-a"), false, "an aborted run must not linger in memory");
});

test("release clears the entry without aborting; a later abort reports no live controller", () => {
  const signal = registerSetupRun("google", "run-b");
  releaseSetupRun("google", "run-b");
  assert.equal(setupRunRegistered("google", "run-b"), false, "a finished run must not linger in memory");
  assert.equal(abortSetupRun("google", "run-b"), false);
  assert.equal(signal.aborted, false);
});

test("kinds are namespaced — aborting the m365 run leaves a same-id google run alone", () => {
  const m365 = registerSetupRun("m365", "run-c");
  const google = registerSetupRun("google", "run-c");
  abortSetupRun("m365", "run-c");
  assert.equal(m365.aborted, true);
  assert.equal(google.aborted, false);
  releaseSetupRun("google", "run-c");
});

test("stopAutoSetupJobs stops each matching in-flight job and survives one that lost the race", async () => {
  let capturedWhere: any;
  const db = {
    job: {
      findMany: async ({ where }: any) => {
        capturedWhere = where;
        return [{ id: "j1" }, { id: "j2" }, { id: "j3" }];
      },
    },
  } as any;
  const stops: string[] = [];
  const svc = {
    stopJob: async (jobId: string) => {
      if (jobId === "j2") throw new Error("job is succeeded — only an in-flight or queued step can be stopped");
      stops.push(jobId);
      return {};
    },
  };
  const stopped = await stopAutoSetupJobs(db, svc, { marker: "m365AutoSetup", systemKeys: ["entra-devicecode"], clientId: "c1", actor: "ui:cancel" });
  assert.equal(stopped, 2);
  assert.deepEqual(stops, ["j1", "j3"]);
  // The query targets only in-flight jobs of the flow's own systemKeys on marker-flagged cases.
  assert.deepEqual(capturedWhere.status, { in: ["pending", "dispatched", "running"] });
  assert.deepEqual(capturedWhere.systemKey, { in: ["entra-devicecode"] });
  assert.deepEqual(capturedWhere.case.payload, { path: ["m365AutoSetup"], equals: true });
  assert.equal(capturedWhere.case.clientId, "c1");
});

test("stopAutoSetupJobs omits the client filter for a fleet-wide cancel", async () => {
  let capturedWhere: any;
  const db = { job: { findMany: async ({ where }: any) => { capturedWhere = where; return []; } } } as any;
  const stopped = await stopAutoSetupJobs(db, { stopJob: async () => ({}) }, { marker: "m365AutoSetup", systemKeys: ["entra-devicecode"], actor: "ui:cancel" });
  assert.equal(stopped, 0);
  assert.equal("clientId" in capturedWhere.case, false);
});
