import { test } from "node:test";
import assert from "node:assert/strict";
import { startM365SetupRun } from "./m365-setup-run";

function fakeDb() {
  const state: any = { run: null, clients: [] as any[] };
  return {
    state,
    m365SetupRun: {
      findFirst: async () => null,
      create: async ({ data }: any) => { state.run = { id: "run-1", ...data }; return state.run; },
      update: async ({ data }: any) => { Object.assign(state.run, data); return state.run; },
    },
    m365SetupRunClient: {
      create: async ({ data }: any) => { const row = { id: `rc-${state.clients.length}`, ...data }; state.clients.push(row); return row; },
      update: async ({ where, data }: any) => { const row = state.clients.find((c: any) => c.id === where.id); Object.assign(row, data); return row; },
    },
  } as any;
}
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, slug: `c${i}`, name: `C${i}`, primaryDomain: `c${i}.com`, delineaFolderId: null }));
const drain = async () => { await new Promise((r) => setImmediate(r)); };

test("a client without a GA secret is skipped and never run", async () => {
  const db = fakeDb();
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startM365SetupRun(db, { scope: "client:c0", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => false, detach: (fn) => { void fn(); },
  });
  assert.equal(r.started, true);
  await drain();
  assert.equal(db.state.clients[0].status, "skipped");
  assert.match(db.state.clients[0].skipReason, /m365-global-admin/);
  assert.equal(db.state.run.skipped, 1);
  assert.equal(db.state.run.status, "done");
});

test("a successful client increments succeeded and records appId", async () => {
  const db = fakeDb();
  const runSetup = async () => ({ ok: true, stage: "done", appId: "app-x", wroteCreds: true, verified: true, actions: [] } as any);
  await startM365SetupRun(db, { scope: "client:c0", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients[0].status, "done");
  assert.equal(db.state.clients[0].appId, "app-x");
  assert.equal(db.state.run.succeeded, 1);
});

test("a browser-signin failure is recorded as failed with the warnings", async () => {
  const db = fakeDb();
  const runSetup = async () => ({ ok: false, stage: "browser-signin", error: "device code not recognized", browserWarnings: ["WARN MFA push not automatable"], actions: [] } as any);
  await startM365SetupRun(db, { scope: "fleet", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients[0].status, "failed");
  assert.deepEqual(db.state.clients[0].warnings, ["WARN MFA push not automatable"]);
  assert.equal(db.state.run.failed, 1);
});

test("a target with gaSecretRef is NOT skipped even when hasGlobalAdminSecret is false, and the ref reaches runSetup", async () => {
  const db = fakeDb();
  let calledWith: unknown;
  const runSetup = async (client: any, tenant: string, gaSecretRef?: string) => {
    calledWith = gaSecretRef;
    return { ok: true, stage: "done", appId: "app-x", actions: [] } as any;
  };
  const t = { ...targets(1)[0], gaSecretRef: "delinea-ext-123" };
  await startM365SetupRun(db, { scope: "client:c0", targets: [t], startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => false, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients[0].status, "done");
  assert.ok(!/m365-global-admin/.test(db.state.clients[0].skipReason ?? ""));
  assert.equal(calledWith, "delinea-ext-123");
});

test("dry-run marks eligible clients skipped-preview without calling runSetup", async () => {
  const db = fakeDb();
  const runSetup = async () => { throw new Error("must not run in dry-run"); };
  await startM365SetupRun(db, { scope: "fleet", targets: targets(2), dryRun: true, startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients.length, 2);
  assert.equal(db.state.clients[0].status, "skipped");
  assert.match(db.state.clients[0].skipReason, /dry run|would run|preview/i);
});

test("a duplicate run is rejected while a recent run is live", async () => {
  const db = fakeDb();
  const t = Date.now();
  const now = () => new Date(t);
  const liveRun = { id: "run-live", scope: "fleet", status: "running", startedAt: new Date(t - 1000) };
  db.m365SetupRun.findFirst = async () => liveRun;
  let created = false;
  db.m365SetupRun.create = async () => { created = true; return {}; };
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startM365SetupRun(db, { scope: "fleet", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); }, now,
  });
  await drain();
  assert.equal(r.started, false);
  assert.equal(r.id, "run-live");
  assert.equal(created, false);
});

test("a running fleet run blocks a per-client start (cross-family exclusion)", async () => {
  const db = fakeDb();
  const t = Date.now();
  const now = () => new Date(t);
  const fleetRun = { id: "run-fleet", scope: "fleet", status: "running", startedAt: new Date(t - 1000) };
  db.m365SetupRun.findFirst = async ({ where }: any) => (where.scope === "fleet" ? fleetRun : null);
  let created = false;
  db.m365SetupRun.create = async () => { created = true; return {}; };
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startM365SetupRun(db, { scope: "client:c1", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); }, now,
  });
  await drain();
  assert.equal(r.started, false);
  assert.equal(r.id, "run-fleet");
  assert.equal(created, false);
});

test("a running per-client run blocks a fleet start (cross-family exclusion)", async () => {
  const db = fakeDb();
  const t = Date.now();
  const now = () => new Date(t);
  const clientRun = { id: "run-client-x", scope: "client:x", status: "running", startedAt: new Date(t - 1000) };
  db.m365SetupRun.findFirst = async ({ where }: any) =>
    (where.scope && typeof where.scope === "object" && where.scope.startsWith === "client:") ? clientRun : null;
  let created = false;
  db.m365SetupRun.create = async () => { created = true; return {}; };
  const runSetup = async () => { throw new Error("must not run"); };
  const r = await startM365SetupRun(db, { scope: "fleet", targets: targets(1), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); }, now,
  });
  await drain();
  assert.equal(r.started, false);
  assert.equal(r.id, "run-client-x");
  assert.equal(created, false);
});

test("a stale run is recovered and a new run starts", async () => {
  const db = fakeDb();
  const t = Date.now();
  const now = () => new Date(t);
  const staleRun = { id: "run-stale", scope: "fleet", status: "running", startedAt: new Date(t - (4 * 60 * 60 * 1000)) };
  db.m365SetupRun.findFirst = async () => staleRun;
  const defaultUpdate = db.m365SetupRun.update;
  db.m365SetupRun.update = async (args: any) => {
    if (args.where.id === staleRun.id) { Object.assign(staleRun, args.data); return staleRun; }
    return defaultUpdate(args);
  };
  const r = await startM365SetupRun(db, { scope: "fleet", targets: targets(1), startedBy: null }, {
    runSetup: async () => ({ ok: true, stage: "done", actions: [] } as any),
    hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); }, now,
  });
  assert.equal(r.started, true);
  assert.equal(staleRun.status, "failed");
  await drain();
  assert.equal(db.state.run.status, "done");
});

test("dry-run marks ineligible clients skipped-preview with a 'would skip' reason", async () => {
  const db = fakeDb();
  const runSetup = async () => { throw new Error("must not run in dry-run"); };
  await startM365SetupRun(db, { scope: "client:c0", targets: targets(1), dryRun: true, startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => false, detach: (fn) => { void fn(); },
  });
  await drain();
  assert.equal(db.state.clients[0].status, "skipped");
  assert.match(db.state.clients[0].skipReason, /would skip/);
});

test("the deadline stops starting new clients", async () => {
  const db = fakeDb();
  let t = 0; const now = () => new Date(t);
  const runSetup = async () => { t += 1000; return { ok: true, stage: "done", actions: [] } as any; };
  await startM365SetupRun(db, { scope: "fleet", targets: targets(5), startedBy: null }, {
    runSetup, hasGlobalAdminSecret: async () => true, detach: (fn) => { void fn(); }, now, deadlineMs: 1500,
  });
  await drain();
  const ran = db.state.clients.filter((c: any) => c.status === "done").length;
  const deadlined = db.state.clients.filter((c: any) => c.status === "skipped" && /deadline/i.test(c.skipReason ?? "")).length;
  assert.ok(ran <= 2, `ran ${ran}`);
  assert.ok(deadlined >= 1, "some clients marked deadline-skipped");
});
