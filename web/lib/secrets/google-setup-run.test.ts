import { test } from "node:test";
import assert from "node:assert/strict";
import { startGoogleSetupRun, ensureGoogleConnTestTriggered } from "./google-setup-run";

function fakeDb() {
  const state: any = { run: null, clients: [] as any[] };
  return {
    state,
    googleSetupRun: {
      findFirst: async () => null,
      create: async ({ data }: any) => { state.run = { id: "run-1", ...data }; return state.run; },
      update: async ({ data }: any) => { Object.assign(state.run, data); return state.run; },
    },
    googleSetupRunClient: {
      create: async ({ data }: any) => { const row = { id: `rc-${state.clients.length}`, ...data }; state.clients.push(row); return row; },
      update: async ({ where, data }: any) => { const row = state.clients.find((c: any) => c.id === where.id); Object.assign(row, data); return row; },
    },
  } as any;
}
const client = { id: "c0", slug: "c0", name: "C0", delineaFolderId: null };
const drain = async () => { await new Promise((r) => setImmediate(r)); };

test("a client run is started and recorded as done on success", async () => {
  const db = fakeDb();
  const runSetup = async (onStage: any) => {
    await onStage("provision", { saEmail: "sa@c0.iam.gserviceaccount.com", saClientId: "12345" });
    return { ok: true, stage: "done", saEmail: "sa@c0.iam.gserviceaccount.com", saClientId: "12345", externalId: "ext-1", verified: true, browserWarnings: [], actions: ["did stuff"] } as any;
  };
  const r = await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  assert.equal(r.started, true);
  await drain();
  assert.equal(db.state.clients[0].status, "done");
  assert.equal(db.state.clients[0].saEmail, "sa@c0.iam.gserviceaccount.com");
  assert.equal(db.state.clients[0].saClientId, "12345");
  assert.equal(db.state.clients[0].verified, true);
  assert.deepEqual(db.state.clients[0].log, ["did stuff"]);
  assert.equal(db.state.run.status, "done");
});

test("a duplicate run is rejected while a recent run is live", async () => {
  const db = fakeDb();
  const t = Date.now();
  const now = () => new Date(t);
  const liveRun = { id: "run-live", scope: "client:c0", status: "running", startedAt: new Date(t - 1000) };
  db.googleSetupRun.findFirst = async () => liveRun;
  let created = false;
  db.googleSetupRun.create = async () => { created = true; return {}; };
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); }, now });
  await drain();
  assert.equal(r.started, false);
  assert.equal(r.reason, "a setup run is already in progress");
  assert.equal(created, false);
});

test("a lost create race (unique-violation on the partial index) is reported, not thrown", async () => {
  const db = fakeDb();
  // findFirst sees no live run (the pre-check loses the race too — that's the whole point of the
  // test), but the create itself hits the DB's partial unique index because a concurrent caller for
  // the same scope beat us to it. Simulate the P2002-shaped rejection and a since-created winner row.
  const winner = { id: "run-winner", scope: "client:c0", status: "running", startedAt: new Date() };
  let findFirstCalls = 0;
  db.googleSetupRun.findFirst = async () => {
    findFirstCalls += 1;
    return findFirstCalls === 1 ? null : winner;
  };
  db.googleSetupRun.create = async () => {
    const err: any = new Error("Unique constraint failed on the fields: (`scope`)");
    err.code = "P2002";
    throw err;
  };
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  assert.equal(r.started, false);
  if (r.started) throw new Error("unreachable");
  assert.equal(r.reason, "a setup run is already in progress");
  assert.equal(r.id, "run-winner");
});

test("a stale run is recovered and a new run starts", async () => {
  const db = fakeDb();
  const t = Date.now();
  const now = () => new Date(t);
  const staleRun = { id: "run-stale", scope: "client:c0", status: "running", startedAt: new Date(t - 4 * 60 * 60 * 1000) };
  db.googleSetupRun.findFirst = async () => staleRun;
  const defaultUpdate = db.googleSetupRun.update;
  db.googleSetupRun.update = async (args: any) => {
    if (args.where.id === staleRun.id) { Object.assign(staleRun, args.data); return staleRun; }
    return defaultUpdate(args);
  };
  const runSetup = async () => ({ ok: true, stage: "done", browserWarnings: [], actions: [] } as any);
  const r = await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); }, now });
  assert.equal(r.started, true);
  assert.equal(staleRun.status, "failed");
  await drain();
  assert.equal(db.state.run.status, "done");
});

test("onStage live-updates this client's row (stage + saEmail/saClientId as they arrive)", async () => {
  const db = fakeDb();
  const runSetup = async (onStage: any) => {
    await onStage("eligibility");
    assert.equal(db.state.clients[0].stage, "eligibility");
    await onStage("provision", { saEmail: "sa@c0.iam.gserviceaccount.com" });
    assert.equal(db.state.clients[0].stage, "provision");
    assert.equal(db.state.clients[0].saEmail, "sa@c0.iam.gserviceaccount.com");
    return { ok: true, stage: "done", saEmail: "sa@c0.iam.gserviceaccount.com", browserWarnings: [], actions: [] } as any;
  };
  await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  await drain();
  assert.equal(db.state.clients[0].status, "done");
  assert.equal(db.state.clients[0].stage, "done");
});

test("terminal mapping: ok + no userAction -> done", async () => {
  const db = fakeDb();
  const runSetup = async () => ({ ok: true, stage: "done", browserWarnings: [], actions: [] } as any);
  await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  await drain();
  assert.equal(db.state.clients[0].status, "done");
  assert.equal(db.state.run.status, "done");
  assert.equal(db.state.run.succeeded, 1);
});

test("terminal mapping: ok + userAction (manual DWD fallback) -> needs_action", async () => {
  const db = fakeDb();
  const userAction = { kind: "dwd", clientId: "12345", scopes: ["https://www.googleapis.com/auth/admin.directory.user"] };
  const runSetup = async () => ({ ok: true, stage: "done", userAction, browserWarnings: [], actions: ["DWD fallback"] } as any);
  await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  await drain();
  assert.equal(db.state.clients[0].status, "needs_action");
  assert.deepEqual(db.state.clients[0].userAction, userAction);
  assert.equal(db.state.run.status, "needs_action");
});

test("terminal mapping: not ok -> failed, error recorded", async () => {
  const db = fakeDb();
  const runSetup = async () => ({ ok: false, stage: "provision", error: "GCP API disabled", browserWarnings: [], actions: ["failed at provision: GCP API disabled"] } as any);
  await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  await drain();
  assert.equal(db.state.clients[0].status, "failed");
  assert.equal(db.state.clients[0].error, "GCP API disabled");
  assert.equal(db.state.run.status, "failed");
  assert.equal(db.state.run.failed, 1);
});

test("a thrown runSetup is recorded as failed, not left running", async () => {
  const db = fakeDb();
  const runSetup = async () => { throw new Error("boom"); };
  await startGoogleSetupRun(db, { client, startedBy: null, seedSecretRef: "seed-1", forceRotate: false, runSetup }, { detach: (fn) => { void fn(); } });
  await drain();
  assert.equal(db.state.clients[0].status, "failed");
  assert.match(db.state.clients[0].error, /boom/);
  assert.equal(db.state.run.status, "failed");
});

// --- conn-test trigger-once semantics (adjudicated: fires on done OR needs_action; the auto-triggered
// google-workspace conn test is itself the verification signal on a kept-valid re-run path) ------------

function fakeConnDb(vaultedId: string | null | undefined) {
  const state: any = { secret: { externalId: vaultedId }, tests: [] as any[] };
  return {
    state,
    secret: { findUnique: async () => state.secret },
    connectionTest: {
      findFirst: async () => {
        if (state.tests.length === 0) return null;
        return [...state.tests].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];
      },
    },
  } as any;
}

function fakeRunner(db: any) {
  const calls: string[] = [];
  return {
    calls,
    requestConnectionTests: async (slug: string, systemKey?: string, source?: string) => {
      calls.push(`${slug}:${systemKey}:${source}`);
      db.state.tests.push({ requestedAt: new Date(), status: "pending", detail: null, accessOk: null, accessDetail: null, fieldsOk: null, fieldsDetail: null, finishedAt: null });
      return { tests: [] };
    },
  };
}

test("conn-test trigger fires exactly once across two GETs", async () => {
  const db = fakeConnDb("SS-real-id");
  const runner = fakeRunner(db);
  const run = { status: "done", finishedAt: new Date(Date.now() - 1000) };
  await ensureGoogleConnTestTriggered(db, runner, { id: "c0", slug: "c0" }, run);
  await ensureGoogleConnTestTriggered(db, runner, { id: "c0", slug: "c0" }, run);
  assert.equal(runner.calls.length, 1, `expected exactly one trigger, got ${runner.calls.length}`);
});

test("conn-test trigger fires on a needs_action run", async () => {
  const db = fakeConnDb("SS-real-id");
  const runner = fakeRunner(db);
  const run = { status: "needs_action", finishedAt: new Date(Date.now() - 1000) };
  await ensureGoogleConnTestTriggered(db, runner, { id: "c0", slug: "c0" }, run);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0], "c0:google-workspace:google-setup");
});

test("conn-test trigger does NOT fire when no vaulted google-admin id exists", async () => {
  const db = fakeConnDb(null);
  const runner = fakeRunner(db);
  const run = { status: "done", finishedAt: new Date(Date.now() - 1000) };
  await ensureGoogleConnTestTriggered(db, runner, { id: "c0", slug: "c0" }, run);
  assert.equal(runner.calls.length, 0);
});

test("conn-test trigger does NOT fire when the run is still running", async () => {
  const db = fakeConnDb("SS-real-id");
  const runner = fakeRunner(db);
  const run = { status: "running", finishedAt: null };
  await ensureGoogleConnTestTriggered(db, runner, { id: "c0", slug: "c0" }, run);
  assert.equal(runner.calls.length, 0);
});

test("the newest google-workspace conn-test verdict is always included in the payload", async () => {
  const db = fakeConnDb("SS-real-id");
  const runner = fakeRunner(db);
  const run = { status: "done", finishedAt: new Date(Date.now() - 1000) };
  const verdict = await ensureGoogleConnTestTriggered(db, runner, { id: "c0", slug: "c0" }, run);
  assert.equal(verdict?.status, "pending");
});
