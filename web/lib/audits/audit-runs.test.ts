import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuditKind, isStale, startRun, STALE_AFTER_MS } from "./audit-runs";

test("only the two real audit kinds are accepted (the route keys off this)", () => {
  assert.ok(isAuditKind("permissions"));
  assert.ok(isAuditKind("leaked_seats"));
  for (const bad of ["", "Permissions", "leaked-seats", "../etc", 1, null, undefined]) assert.equal(isAuditKind(bad), false);
});

test("a run is stale only once no real sweep could still be alive", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.equal(isStale(new Date(now.getTime() - 60_000), now), false);
  assert.equal(isStale(new Date(now.getTime() - STALE_AFTER_MS + 1000), now), false);
  assert.equal(isStale(new Date(now.getTime() - STALE_AFTER_MS - 1000), now), true);
});

// A tiny fake of the two db calls startRun makes, so the concurrency rules are testable without a DB.
function fakeDb(live: { id: string; startedAt: Date } | null) {
  const calls: { updated: { id: string; data: Record<string, unknown> }[]; created: number } = { updated: [], created: 0 };
  const db = {
    fleetAudit: {
      findFirst: async () => live,
      create: async () => { calls.created++; return { id: "run-new" }; },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { calls.updated.push({ id: where.id, data }); return {}; },
    },
  };
  return { db: db as never, calls };
}

test("a live scan blocks a second one — a duplicate sweep would only burn Graph quota", () => {
  return (async () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const { db, calls } = fakeDb({ id: "run-live", startedAt: new Date(now.getTime() - 60_000) });
    const r = await startRun(db, "permissions", "user:x", { now: () => now, detach: () => {} });
    assert.deepEqual(r, { started: false, reason: "a scan is already running", id: "run-live" });
    assert.equal(calls.created, 0, "must not create a second run");
  })();
});

// Without this, one crashed run wedges the button forever: nothing else ever marks it finished.
test("a STALE 'running' run is failed honestly and does not block a new scan", async () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const { db, calls } = fakeDb({ id: "run-dead", startedAt: new Date(now.getTime() - STALE_AFTER_MS - 1) });
  const r = await startRun(db, "permissions", "user:x", { now: () => now, detach: () => {} });
  assert.equal(r.started, true);
  assert.equal(calls.created, 1);
  const closed = calls.updated.find((u) => u.id === "run-dead")!;
  assert.equal(closed.data.status, "failed");
  assert.match(String(closed.data.error), /restarted/i, "say what happened rather than leaving it hanging");
});

test("with no live run, a scan starts and the work is detached from the request", async () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const { db, calls } = fakeDb(null);
  let detached = false;
  const r = await startRun(db, "leaked_seats", "user:x", { now: () => now, detach: () => { detached = true; } });
  assert.deepEqual(r, { started: true, id: "run-new" });
  assert.equal(calls.created, 1);
  // A sweep takes minutes — it must never be awaited inside the POST.
  assert.ok(detached, "the sweep must run detached from the request");
});
