import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentOnlineState, rollUpAgents, summarizeAgents, jobIsWedged, jobIsStaleDispatched, clusterFailures,
  AGENT_ONLINE_MS, LEASE_MS, PROGRESS_STALE_MS, PROGRESS_FUTURE_SKEW_MS, type AgentInput,
} from "./health";

const NOW = 1_000_000_000_000;
const OFFLINE_MS = 15 * 60_000;

test("agentOnlineState: boundaries against the 90s window and the offline threshold", () => {
  assert.equal(agentOnlineState(NOW, NOW, OFFLINE_MS), "online");
  assert.equal(agentOnlineState(NOW - AGENT_ONLINE_MS, NOW, OFFLINE_MS), "online"); // exactly 90s = still online
  assert.equal(agentOnlineState(NOW - AGENT_ONLINE_MS - 1, NOW, OFFLINE_MS), "at-risk");
  assert.equal(agentOnlineState(NOW - OFFLINE_MS, NOW, OFFLINE_MS), "at-risk"); // exactly threshold = at-risk
  assert.equal(agentOnlineState(NOW - OFFLINE_MS - 1, NOW, OFFLINE_MS), "offline");
  assert.equal(agentOnlineState(null, NOW, OFFLINE_MS), "offline"); // never seen
});

const BUILD = "a1b2c3d4e5f6";

test("rollUpAgents: buildCurrent only for an exact build-hash match", () => {
  const agents: AgentInput[] = [
    { id: "cur", clientId: null, priority: 100, lastSeenAtMs: NOW, version: BUILD },
    { id: "old", clientId: null, priority: 100, lastSeenAtMs: NOW, version: "oldbuild0000" },
    { id: "legacy", clientId: null, priority: 100, lastSeenAtMs: NOW, version: null },
  ];
  const r = rollUpAgents(agents, BUILD, NOW, OFFLINE_MS);
  assert.equal(r.find((x) => x.id === "cur")!.buildCurrent, true);
  assert.equal(r.find((x) => x.id === "old")!.buildCurrent, false);
  assert.equal(r.find((x) => x.id === "legacy")!.buildCurrent, false);
});

test("rollUpAgents: standby re-derivation matches shouldStandBy, scoped by clientId", () => {
  const agents: AgentInput[] = [
    { id: "primary", clientId: "c1", priority: 1, lastSeenAtMs: NOW, version: BUILD },
    { id: "backup", clientId: "c1", priority: 2, lastSeenAtMs: NOW, version: BUILD },
    // a lower-priority peer in a DIFFERENT scope must NOT force this one to stand by
    { id: "other", clientId: "c2", priority: 5, lastSeenAtMs: NOW, version: BUILD },
  ];
  const r = rollUpAgents(agents, BUILD, NOW, OFFLINE_MS);
  assert.equal(r.find((x) => x.id === "primary")!.standby, false);
  assert.equal(r.find((x) => x.id === "backup")!.standby, true); // strictly-higher peer online
  assert.equal(r.find((x) => x.id === "other")!.standby, false);
});

test("rollUpAgents: a standby whose primary is OFFLINE takes over (no online higher peer)", () => {
  const agents: AgentInput[] = [
    { id: "primary", clientId: "c1", priority: 1, lastSeenAtMs: NOW - OFFLINE_MS - 1, version: BUILD }, // offline
    { id: "backup", clientId: "c1", priority: 2, lastSeenAtMs: NOW, version: BUILD },
  ];
  const r = rollUpAgents(agents, BUILD, NOW, OFFLINE_MS);
  assert.equal(r.find((x) => x.id === "backup")!.standby, false); // primary offline -> not standing by
});

test("summarizeAgents: counts each bucket + build-current + standby", () => {
  const agents: AgentInput[] = [
    { id: "a", clientId: "c1", priority: 1, lastSeenAtMs: NOW, version: BUILD },
    { id: "b", clientId: "c1", priority: 2, lastSeenAtMs: NOW, version: "oldbuild0000" },
    { id: "c", clientId: null, priority: 1, lastSeenAtMs: NOW - OFFLINE_MS - 1, version: BUILD },
  ];
  const sum = summarizeAgents(rollUpAgents(agents, BUILD, NOW, OFFLINE_MS));
  assert.equal(sum.total, 3);
  assert.equal(sum.online, 2);
  assert.equal(sum.offline, 1);
  assert.equal(sum.buildCurrent, 2);
  assert.equal(sum.standby, 1); // b stands by behind a
});

test("jobIsWedged: matches the claim() PROGRESS_STALE_MS + future-skew predicate", () => {
  const w = (o: Partial<{ status: string; progressAtMs: number | null; startedAtMs: number | null }>) =>
    jobIsWedged({ status: "running", progressAtMs: null, startedAtMs: null, ...o }, NOW);
  assert.equal(w({ progressAtMs: NOW }), false); // fresh
  assert.equal(w({ progressAtMs: NOW - PROGRESS_STALE_MS + 1 }), false); // just under
  assert.equal(w({ progressAtMs: NOW - PROGRESS_STALE_MS - 1 }), true); // over
  assert.equal(w({ progressAtMs: NOW + PROGRESS_FUTURE_SKEW_MS + 1 }), true); // clock-skew future
  assert.equal(w({ progressAtMs: null, startedAtMs: NOW - PROGRESS_STALE_MS - 1 }), true); // falls back to startedAt
  assert.equal(w({ progressAtMs: null, startedAtMs: null }), false); // no timestamps -> not wedged
  // only "running" jobs are wedge candidates
  assert.equal(jobIsWedged({ status: "dispatched", progressAtMs: NOW - PROGRESS_STALE_MS - 1, startedAtMs: null }, NOW), false);
});

test("jobIsStaleDispatched: matches the claim() LEASE_MS predicate", () => {
  assert.equal(jobIsStaleDispatched({ status: "dispatched", progressAtMs: null, startedAtMs: NOW - LEASE_MS + 1 }, NOW), false);
  assert.equal(jobIsStaleDispatched({ status: "dispatched", progressAtMs: null, startedAtMs: NOW - LEASE_MS - 1 }, NOW), true);
  assert.equal(jobIsStaleDispatched({ status: "dispatched", progressAtMs: null, startedAtMs: null }, NOW), false);
  assert.equal(jobIsStaleDispatched({ status: "running", progressAtMs: null, startedAtMs: NOW - LEASE_MS - 1 }, NOW), false);
});

test("clusterFailures: groups by client+system, biggest first, capped", () => {
  const rows = [
    { clientName: "Acme", systemKey: "m365" },
    { clientName: "Acme", systemKey: "m365" },
    { clientName: "Acme", systemKey: "egnyte" },
    { clientName: "Beta", systemKey: "m365" },
  ];
  const c = clusterFailures(rows, 8);
  assert.equal(c[0].clientName, "Acme");
  assert.equal(c[0].systemKey, "m365");
  assert.equal(c[0].count, 2);
  assert.equal(c.length, 3);
  assert.equal(clusterFailures(rows, 1).length, 1);
});
