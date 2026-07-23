import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCutover, canAct, canAdvance, nextPhase, agentRehomeVerdict, fleetRehomeSummary,
  canConfirm, EMPTY_CUTOVER, type CutoverState, type AgentRehomeInput, type RehomeVerdict,
} from "./cutover";

const AZURE = "https://iam.example.com";
const OLD = "http://192.168.1.10:3000";

function stateAt(phase: CutoverState["phase"], over: Partial<CutoverState> = {}): CutoverState {
  return { ...EMPTY_CUTOVER, phase, azureUrl: AZURE, oldUrl: OLD, ...over };
}

// ── normalizeCutover ────────────────────────────────────────────────────────────────────────────
test("normalizeCutover: non-object / corrupt reads as idle", () => {
  assert.equal(normalizeCutover(null).phase, "idle");
  assert.equal(normalizeCutover("nope").phase, "idle");
  assert.equal(normalizeCutover(42).phase, "idle");
  assert.deepEqual(normalizeCutover({}), EMPTY_CUTOVER);
});

test("normalizeCutover: an unknown phase falls back to idle (never stuck)", () => {
  assert.equal(normalizeCutover({ phase: "wat" }).phase, "idle");
});

test("normalizeCutover: trims url, coerces flags, keeps known fields", () => {
  const s = normalizeCutover({ phase: "staged", azureUrl: "  https://x/  ", oldUrl: "http://old", acknowledgedStragglers: true, startedBy: "a@b" });
  assert.equal(s.phase, "staged");
  assert.equal(s.azureUrl, "https://x/");
  assert.equal(s.oldUrl, "http://old");
  assert.equal(s.acknowledgedStragglers, true);
  assert.equal(s.startedBy, "a@b");
});

// ── transition guards ───────────────────────────────────────────────────────────────────────────
test("canAct: stage is legal pre-push and after a finished run, illegal mid-push", () => {
  for (const p of ["idle", "staged", "draining", "complete", "rolled-back"] as const) assert.equal(canAct(stateAt(p), "stage"), true, p);
  for (const p of ["pushing", "verifying-agents", "verifying-db"] as const) assert.equal(canAct(stateAt(p), "stage"), false, p);
});

test("canAct: push only from staged/draining", () => {
  assert.equal(canAct(stateAt("staged"), "push"), true);
  assert.equal(canAct(stateAt("draining"), "push"), true);
  assert.equal(canAct(stateAt("idle"), "push"), false);
  assert.equal(canAct(stateAt("pushing"), "push"), false);
});

test("canAct: confirm illegal before a push is in flight", () => {
  assert.equal(canAct(stateAt("idle"), "confirm"), false);
  assert.equal(canAct(stateAt("staged"), "confirm"), false);
  assert.equal(canAct(stateAt("pushing"), "confirm"), true);
});

test("canAct: rollback legal from staged through verifying, not from idle/complete", () => {
  for (const p of ["staged", "draining", "pushing", "verifying-agents", "verifying-db"] as const) assert.equal(canAct(stateAt(p), "rollback"), true, p);
  assert.equal(canAct(stateAt("idle"), "rollback"), false);
  assert.equal(canAct(stateAt("complete"), "rollback"), false);
});

test("nextPhase maps each action to its destination phase", () => {
  assert.equal(nextPhase(stateAt("idle"), "stage"), "staged");
  assert.equal(nextPhase(stateAt("staged"), "push"), "pushing");
  assert.equal(nextPhase(stateAt("pushing"), "confirm"), "complete");
  assert.equal(nextPhase(stateAt("pushing"), "rollback"), "rolled-back");
  // ackStragglers doesn't advance the phase
  assert.equal(nextPhase(stateAt("pushing"), "ackStragglers"), "pushing");
  // illegal action leaves the phase untouched (caller gates on canAct)
  assert.equal(nextPhase(stateAt("idle"), "confirm"), "idle");
});

test("canAdvance: illegal jumps are rejected", () => {
  assert.equal(canAdvance(stateAt("idle"), "pushing"), false); // must stage first
  assert.equal(canAdvance(stateAt("idle"), "staged"), true);
  assert.equal(canAdvance(stateAt("staged"), "pushing"), true);
  assert.equal(canAdvance(stateAt("complete"), "pushing"), false);
  assert.equal(canAdvance(stateAt("rolled-back"), "staged"), true);
});

// ── agentRehomeVerdict ──────────────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-07-23T00:00:00Z");
function agent(over: Partial<AgentRehomeInput>): AgentRehomeInput {
  return {
    id: "a1", name: "agent-1",
    migrateRequested: false, migrateRequestedBy: null, migrateDeliveredAt: null,
    migratedAt: null, migrateError: null, lastSeenAt: null, currentAppUrl: null, ...over,
  };
}
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("verdict green: migrated + reported on the Azure URL within the online window", () => {
  const v = agentRehomeVerdict(agent({ migratedAt: iso(1000), currentAppUrl: AZURE, lastSeenAt: iso(5000) }), AZURE, NOW);
  assert.equal(v.kind, "green");
  assert.equal(v.reasonCode, "migrated");
});

test("verdict red: migrateError recorded (move failed, still on old URL)", () => {
  const v = agentRehomeVerdict(agent({ migrateError: "verify failed", currentAppUrl: OLD, lastSeenAt: iso(5000) }), AZURE, NOW);
  assert.equal(v.kind, "red");
  assert.equal(v.reasonCode, "failed");
});

test("verdict red: offline and still not converged (the straggler blocking cutover)", () => {
  const v = agentRehomeVerdict(agent({ currentAppUrl: OLD, lastSeenAt: iso(30 * 60_000) }), AZURE, NOW);
  assert.equal(v.kind, "red");
  assert.equal(v.reasonCode, "offline-unconverged");
});

test("verdict red: never seen at all counts as offline-unconverged", () => {
  const v = agentRehomeVerdict(agent({ lastSeenAt: null, currentAppUrl: null }), AZURE, NOW);
  assert.equal(v.kind, "red");
  assert.equal(v.reasonCode, "offline-unconverged");
});

test("verdict pending: converged but quiet (re-homed, no recent beat)", () => {
  const v = agentRehomeVerdict(agent({ migratedAt: iso(60_000), currentAppUrl: AZURE, lastSeenAt: iso(3 * 60_000) }), AZURE, NOW);
  assert.equal(v.kind, "pending");
  assert.equal(v.reasonCode, "converged-quiet");
});

test("verdict pending: recently seen, mid-move, not yet converged", () => {
  // delivered a moment ago, silent since → migrateStatus 'moving'; recently within offline window
  const v = agentRehomeVerdict(agent({ migrateDeliveredAt: iso(10_000), currentAppUrl: OLD, lastSeenAt: iso(20_000) }), AZURE, NOW);
  assert.equal(v.kind, "pending");
});

test("verdict red: returned-old bounce-back", () => {
  const v = agentRehomeVerdict(agent({ migrateDeliveredAt: iso(30_000), currentAppUrl: OLD, lastSeenAt: iso(5_000) }), AZURE, NOW);
  assert.equal(v.kind, "red");
  assert.equal(v.reasonCode, "returned-old");
});

// ── fleetRehomeSummary ──────────────────────────────────────────────────────────────────────────
test("fleetRehomeSummary tallies kinds and counts offline stragglers", () => {
  const vs: RehomeVerdict[] = [
    { agentId: "1", name: "a", kind: "green", reasonCode: "migrated", reason: "" },
    { agentId: "2", name: "b", kind: "green", reasonCode: "migrated", reason: "" },
    { agentId: "3", name: "c", kind: "red", reasonCode: "failed", reason: "" },
    { agentId: "4", name: "d", kind: "red", reasonCode: "offline-unconverged", reason: "" },
    { agentId: "5", name: "e", kind: "pending", reasonCode: "moving", reason: "" },
  ];
  assert.deepEqual(fleetRehomeSummary(vs), { total: 5, green: 2, red: 2, pending: 1, offlineUnconverged: 1 });
});

// ── canConfirm ──────────────────────────────────────────────────────────────────────────────────
const okVerify = { ok: true } as CutoverState["dbVerify"];

test("canConfirm: blocked before a push", () => {
  const r = canConfirm(stateAt("staged", { dbVerify: okVerify }), { total: 1, green: 1, red: 0, pending: 0, offlineUnconverged: 0 });
  assert.equal(r.ok, false);
});

test("canConfirm: blocked while agents still red or pending", () => {
  assert.equal(canConfirm(stateAt("pushing", { dbVerify: okVerify }), { total: 2, green: 1, red: 1, pending: 0, offlineUnconverged: 0 }).ok, false);
  assert.equal(canConfirm(stateAt("pushing", { dbVerify: okVerify }), { total: 2, green: 1, red: 0, pending: 1, offlineUnconverged: 0 }).ok, false);
});

test("canConfirm: blocked until DB verify passes", () => {
  assert.equal(canConfirm(stateAt("pushing"), { total: 1, green: 1, red: 0, pending: 0, offlineUnconverged: 0 }).ok, false);
  assert.equal(canConfirm(stateAt("pushing", { dbVerify: { ok: false } as CutoverState["dbVerify"] }), { total: 1, green: 1, red: 0, pending: 0, offlineUnconverged: 0 }).ok, false);
});

test("canConfirm: all green + dbVerify.ok → ok", () => {
  const r = canConfirm(stateAt("pushing", { dbVerify: okVerify }), { total: 3, green: 3, red: 0, pending: 0, offlineUnconverged: 0 });
  assert.equal(r.ok, true);
});

test("canConfirm: offline stragglers block UNTIL acknowledged, then allow", () => {
  const summary = { total: 3, green: 2, red: 1, pending: 0, offlineUnconverged: 1 };
  assert.equal(canConfirm(stateAt("pushing", { dbVerify: okVerify }), summary).ok, false);
  assert.equal(canConfirm(stateAt("pushing", { dbVerify: okVerify, acknowledgedStragglers: true }), summary).ok, true);
});

test("canConfirm: acknowledged stragglers do NOT excuse a genuine (failed) red", () => {
  const summary = { total: 3, green: 1, red: 2, pending: 0, offlineUnconverged: 1 }; // one failed, one offline
  assert.equal(canConfirm(stateAt("pushing", { dbVerify: okVerify, acknowledgedStragglers: true }), summary).ok, false);
});
