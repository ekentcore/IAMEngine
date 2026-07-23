// Feature #3 — pure fleet-health aggregation. NO Prisma here: every function takes plain data so it
// unit-tests without a DB or a live server (the DB reads live in app/health/fleet/_lib/loader.ts and
// lib/jobs/fleet-alerts.ts, both of which shape their rows into these inputs).
//
// This is a READER. It re-derives — read-only — the SAME predicates dispatch uses (the online window
// from reachability.ts, the wedged/stale-lease cutoffs from runner-service.ts claim(), the standby
// rule from runner-logic.ts) so the board and the alert sweep agree with what actually happens, but it
// never touches claim() or the job state machine.
import { AGENT_ONLINE_MS } from "@/lib/runner/reachability";
import { agentBuildIsCurrent } from "@/lib/jobs/agent-updates";
import { shouldStandBy } from "@/lib/jobs/runner-logic";

export { AGENT_ONLINE_MS };

// Mirror of the claim() reclaim cutoffs (runner-service.ts LEASE_MS / PROGRESS_STALE_MS / futureSkew).
// Those constants are module-private there; we duplicate them here with this comment — the same seam
// reachability.ts uses for AGENT_ONLINE_MS — so the board's "stale"/"wedged" counts match exactly what
// claim() would reclaim, without importing (or invoking) the dispatch path.
export const LEASE_MS = 10 * 60 * 1000; // a dispatched job whose lease went stale
export const PROGRESS_STALE_MS = 20 * 60 * 1000; // a "running" job that stopped narrating progress
export const PROGRESS_FUTURE_SKEW_MS = 10 * 60 * 1000; // a clock-skewed progressAt in the future is just as dead

// ---- Agents -------------------------------------------------------------------------------------

export type AgentOnlineState = "online" | "at-risk" | "offline";

// online: heartbeated within the 90s window dispatch trusts. at-risk: past 90s but not yet the
// operator-configured offline threshold (a beat or two missed — watch it). offline: past the threshold
// (or never seen). offlineMs MUST exceed AGENT_ONLINE_MS (normalizeAlerts guarantees it).
export function agentOnlineState(lastSeenAtMs: number | null, now: number, offlineMs: number): AgentOnlineState {
  if (lastSeenAtMs === null) return "offline";
  const age = now - lastSeenAtMs;
  if (age <= AGENT_ONLINE_MS) return "online";
  if (age <= offlineMs) return "at-risk";
  return "offline";
}

export type AgentInput = {
  id: string;
  clientId: string | null;
  priority: number;
  lastSeenAtMs: number | null;
  version: string | null; // the content-hash build id
};

export type AgentRollup = {
  id: string;
  onlineState: AgentOnlineState;
  buildCurrent: boolean;
  // stands by (claims nothing) because a STRICTLY-higher-priority peer of the same scope is online —
  // re-derived read-only from shouldStandBy. Only meaningful while this agent is itself online.
  standby: boolean;
};

// Classify every agent's online state, build-currency, and standby posture in one pass. Standby is
// scoped exactly like claim(): peers are the OTHER online agents sharing this agent's clientId (a
// client's own agents among themselves; the central runners among themselves).
export function rollUpAgents(agents: AgentInput[], build: string, now: number, offlineMs: number): AgentRollup[] {
  const online = agents.filter((a) => agentOnlineState(a.lastSeenAtMs, now, offlineMs) === "online");
  return agents.map((a) => {
    const onlineState = agentOnlineState(a.lastSeenAtMs, now, offlineMs);
    const peerPriorities = online.filter((p) => p.id !== a.id && p.clientId === a.clientId).map((p) => p.priority);
    return {
      id: a.id,
      onlineState,
      buildCurrent: agentBuildIsCurrent(a.version, build),
      standby: onlineState === "online" && shouldStandBy(a.priority, peerPriorities),
    };
  });
}

export type AgentSummary = { total: number; online: number; atRisk: number; offline: number; buildCurrent: number; standby: number };

export function summarizeAgents(rollups: AgentRollup[]): AgentSummary {
  const s: AgentSummary = { total: rollups.length, online: 0, atRisk: 0, offline: 0, buildCurrent: 0, standby: 0 };
  for (const r of rollups) {
    if (r.onlineState === "online") s.online++;
    else if (r.onlineState === "at-risk") s.atRisk++;
    else s.offline++;
    if (r.buildCurrent) s.buildCurrent++;
    if (r.standby) s.standby++;
  }
  return s;
}

// ---- Jobs: the exact claim() reclaim predicates, read-only ---------------------------------------

export type JobTimes = { status: string; progressAtMs: number | null; startedAtMs: number | null };

// A "running" job that has wedged — the claim() wedged predicate (runner-service.ts): progress older
// than PROGRESS_STALE_MS, or a future-skewed progressAt, keyed off the job's own progressAt (falling
// back to startedAt when it never posted progress).
export function jobIsWedged(j: JobTimes, now: number): boolean {
  if (j.status !== "running") return false;
  const stale = now - PROGRESS_STALE_MS;
  const future = now + PROGRESS_FUTURE_SKEW_MS;
  const t = j.progressAtMs ?? j.startedAtMs;
  if (t === null) return false;
  return t < stale || t > future;
}

// A "dispatched" job whose lease went stale — the claim() stale-lease predicate: startedAt older than
// LEASE_MS (the assigned runner never posted a result).
export function jobIsStaleDispatched(j: JobTimes, now: number): boolean {
  if (j.status !== "dispatched") return false;
  return j.startedAtMs !== null && j.startedAtMs < now - LEASE_MS;
}

// ---- Recent-failure clustering -------------------------------------------------------------------

export type FailureRow = { clientName: string | null; systemKey: string };
export type FailureCluster = { key: string; clientName: string | null; systemKey: string; count: number };

// Group recent failures by client+system, biggest first — the board's "top offenders" and the
// repeatedFailures digest body both read this.
export function clusterFailures(rows: FailureRow[], topN = 8): FailureCluster[] {
  const map = new Map<string, FailureCluster>();
  for (const r of rows) {
    const key = `${r.clientName ?? "—"}|${r.systemKey}`;
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, { key, clientName: r.clientName, systemKey: r.systemKey, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, topN);
}
