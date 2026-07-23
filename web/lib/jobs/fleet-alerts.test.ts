import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAlerts, normalizeAlertState, dueToFire, evalQueueBacklog, evalRepeatedFailures,
  evalBackupStale, planAgentOfflineAlerts, DEFAULT_ALERTS, type OfflineAgent,
} from "./fleet-alerts";
import { AGENT_ONLINE_MS } from "../runner/reachability";

test("normalizeAlerts: defaults + clamps agentOfflineMinutes above the 90s window", () => {
  const d = normalizeAlerts(null);
  assert.deepEqual(d, DEFAULT_ALERTS);
  // a sub-window value is clamped up (offline must not overlap the online window)
  const clamped = normalizeAlerts({ agentOfflineMinutes: 1 });
  assert.ok(clamped.agentOfflineMinutes * 60_000 > AGENT_ONLINE_MS);
  // invalid / zero / negative fall back to defaults
  assert.equal(normalizeAlerts({ queueDepth: 0 }).queueDepth, DEFAULT_ALERTS.queueDepth);
  assert.equal(normalizeAlerts({ failureCount: -3 }).failureCount, DEFAULT_ALERTS.failureCount);
  // a valid override is honored
  assert.equal(normalizeAlerts({ queueDepth: 50 }).queueDepth, 50);
});

test("normalizeAlertState: tolerates junk, keeps only string firedAt stamps", () => {
  const s = normalizeAlertState({ lastSweepAt: "2026-07-23T00:00:00.000Z", rules: { a: { firedAt: "x" }, b: { firedAt: 5 }, c: "nope" } });
  assert.equal(s.lastSweepAt, "2026-07-23T00:00:00.000Z");
  assert.deepEqual(s.rules, { a: { firedAt: "x" } });
  assert.deepEqual(normalizeAlertState(null).rules, {});
});

test("dueToFire: fires when absent, suppresses within cooldown, re-fires after", () => {
  const now = 1_000_000_000_000;
  const cooldown = 120 * 60_000;
  assert.equal(dueToFire(undefined, now, cooldown), true); // never fired
  assert.equal(dueToFire({ firedAt: new Date(now - 60 * 60_000).toISOString() }, now, cooldown), false); // 60m < 120m
  assert.equal(dueToFire({ firedAt: new Date(now - 121 * 60_000).toISOString() }, now, cooldown), true); // past cooldown
  assert.equal(dueToFire({ firedAt: "not-a-date" }, now, cooldown), true); // unparseable -> fail-open
});

test("evalQueueBacklog: requires BOTH depth and sustained age", () => {
  const s = normalizeAlerts({ queueDepth: 25, queueBacklogMinutes: 15 });
  const ageOver = 20 * 60_000;
  const ageUnder = 5 * 60_000;
  assert.equal(evalQueueBacklog(30, ageOver, s), true);
  assert.equal(evalQueueBacklog(30, ageUnder, s), false); // deep but not sustained (a normal burst)
  assert.equal(evalQueueBacklog(10, ageOver, s), false); // sustained but not deep
  assert.equal(evalQueueBacklog(25, 15 * 60_000, s), true); // exactly at both thresholds
  assert.equal(evalQueueBacklog(30, null, s), false); // no oldest-pending age
});

test("evalRepeatedFailures: at/over the count threshold", () => {
  const s = normalizeAlerts({ failureCount: 5 });
  assert.equal(evalRepeatedFailures(4, s), false);
  assert.equal(evalRepeatedFailures(5, s), true);
  assert.equal(evalRepeatedFailures(9, s), true);
});

test("evalBackupStale: stale when failed, missing, or over the max age", () => {
  assert.equal(evalBackupStale(true, 10, 26), false); // fresh
  assert.equal(evalBackupStale(true, 27, 26), true); // too old
  assert.equal(evalBackupStale(false, 1, 26), true); // last run failed
  assert.equal(evalBackupStale(true, null, 26), true); // no successful backup at all
});

const oa = (id: string, clientName: string | null = null): OfflineAgent => ({ id, name: id, clientName, restricted: false, override: null });

test("planAgentOfflineAlerts: storm guard — individual up to 3, digest beyond", () => {
  assert.equal(planAgentOfflineAlerts([]).kind, "none");
  const three = planAgentOfflineAlerts([oa("a"), oa("b"), oa("c")]);
  assert.equal(three.kind, "individual");
  const four = planAgentOfflineAlerts([oa("a", "X"), oa("b", "X"), oa("c", "Y"), oa("d", "Z")]);
  assert.equal(four.kind, "digest");
  if (four.kind === "digest") {
    assert.equal(four.count, 4);
    assert.equal(four.clients, 3); // X, Y, Z
    assert.equal(four.sample.length, 4);
  }
});
