import { test } from "node:test";
import assert from "node:assert/strict";
import { diffConnOutcome, planConnNotifications, sweepDue, normalizeConnSweep, type ConnFailure } from "./conn-sweep";

test("diffConnOutcome: transitions", () => {
  assert.equal(diffConnOutcome(null, { passed: false }), "new_failure");
  assert.equal(diffConnOutcome({ lastStatus: "ok" }, { passed: false }), "new_failure");
  assert.equal(diffConnOutcome({ lastStatus: "fail" }, { passed: false }), "unchanged");
  assert.equal(diffConnOutcome({ lastStatus: "fail" }, { passed: true }), "recovered");
  assert.equal(diffConnOutcome({ lastStatus: "ok" }, { passed: true }), "unchanged");
  assert.equal(diffConnOutcome(null, { passed: true }), "unchanged");
});

const f = (client: string): ConnFailure => ({ clientName: client, systemKey: "m365", detail: null, restricted: false, override: null });

test("planConnNotifications: individual up to 3, digest beyond", () => {
  assert.equal(planConnNotifications([]).kind, "none");
  const three = planConnNotifications([f("a"), f("b"), f("c")]);
  assert.equal(three.kind, "individual");
  const four = planConnNotifications([f("a"), f("b"), f("c"), f("d")]);
  assert.equal(four.kind, "digest");
  if (four.kind === "digest") { assert.equal(four.count, 4); assert.equal(four.clients, 4); }
});

test("sweepDue: honors enabled, interval, and an in-progress cursor", () => {
  const now = new Date("2026-07-11T12:00:00Z");
  assert.equal(sweepDue(normalizeConnSweep({ enabled: false }), now), false);
  assert.equal(sweepDue(normalizeConnSweep({ enabled: true }), now), true); // never run
  const recent = normalizeConnSweep({ enabled: true, intervalHours: 24, lastStartedAt: new Date(now.getTime() - 3_600_000).toISOString() });
  assert.equal(sweepDue(recent, now), false);
  const old = normalizeConnSweep({ enabled: true, intervalHours: 24, lastStartedAt: new Date(now.getTime() - 25 * 3_600_000).toISOString() });
  assert.equal(sweepDue(old, now), true);
  // an in-progress cursor means "continue", not "start a new run"
  const mid = normalizeConnSweep({ enabled: true, lastStartedAt: new Date(now.getTime() - 25 * 3_600_000).toISOString(), cursorClientId: "c123" });
  assert.equal(sweepDue(mid, now), false);
});
