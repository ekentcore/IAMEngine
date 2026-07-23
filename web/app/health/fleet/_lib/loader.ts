// Shared data assembly for /health/fleet (+ v2/v3 and the /api/health/fleet poll route). Every signal
// is a QUERY-TIME read — there is no stored board state and no heartbeat dependency to VIEW the board.
// This is strictly a reader: it re-derives claim()'s wedged/stale predicates and the standby rule
// read-only (via lib/fleet/health.ts) but never calls claim() or mutates job/agent state.
//
// The Agents panel's online + build-current + migration columns are feature #2's re-homing signal —
// kept first-class here and stable for #2 to consume.
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { parseCapabilities } from "@/lib/runner/capabilities";
import { runnerBuildId, runnerVersion } from "@/lib/runner/bundle";
import { getAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, normalizeUrl, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
import { backupFreshness, type BackupFreshness } from "@/lib/jobs/backup-freshness";
import { normalizeAlerts, normalizeAlertState, ALERTS_KEY, ALERTS_STATE_KEY } from "@/lib/jobs/fleet-alerts";
import {
  rollUpAgents, summarizeAgents, jobIsWedged, jobIsStaleDispatched, clusterFailures,
  type AgentInput, type AgentSummary, type FailureCluster, type AgentOnlineState,
} from "@/lib/fleet/health";

export type FleetAgentVM = {
  id: string;
  name: string;
  scope: string;
  clientName: string | null;
  clientSlug: string | null;
  onlineState: AgentOnlineState;
  lastSeenAt: string | null;
  bootAt: string | null;
  semver: string | null;
  buildShort: string | null;
  buildCurrent: boolean;
  standby: boolean;
  stuckPhase: string | null; // set when this agent owns a wedged in-flight job
  capabilities: string[] | null;
  // migration (feature #2 signal)
  currentAppUrl: string | null;
  migratedAt: string | null;
  migrateError: string | null;
  migrationState: "n/a" | "on target" | "pending" | "error" | "unknown";
};

export type QueueVM = {
  pending: number; // claimable pending api-job depth
  dispatched: number;
  running: number;
  oldestPendingAgeMinutes: number | null;
  wedged: number;
  staleDispatched: number;
  autoStopped24h: number;
};

export type FleetHealthVM = {
  at: string;
  build: { id: string; short: string; version: string | null };
  agents: FleetAgentVM[];
  agentSummary: AgentSummary;
  migrationTarget: string | null;
  queue: QueueVM;
  failures: { window: number; inWindow: number; last24h: number; clusters: FailureCluster[] };
  backups: BackupFreshness;
  db: { up: boolean; clients: number | null; detail: string };
  alerts: {
    thresholds: ReturnType<typeof normalizeAlerts>;
    firing: { key: string; firedAt: string }[];
    lastSweepAt: string | null;
  };
  // A single one-line verdict + the count of standing conditions the board itself detects.
  conditions: string[];
};

export async function loadFleetHealth(now: Date = new Date()): Promise<FleetHealthVM> {
  const nowMs = now.getTime();
  const build = runnerBuildId();
  const buildShort = build.slice(0, 12);

  const [agents, migrationRaw, alertsRaw, alertStateRaw, inflight, freshness] = await Promise.all([
    db.agent.findMany({
      where: { deletedAt: null, enabled: true },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, scope: true, clientId: true, priority: true, lastSeenAt: true, bootAt: true,
        version: true, semver: true, capabilities: true, currentAppUrl: true, migratedAt: true, migrateError: true,
        client: { select: { name: true, slug: true } },
      },
    }),
    getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY),
    getAppSetting<unknown>(db, ALERTS_KEY),
    getAppSetting<unknown>(db, ALERTS_STATE_KEY),
    // In-flight jobs (small set) — classified in-memory with the exact claim() predicates.
    db.job.findMany({
      where: { mode: "api", status: { in: ["dispatched", "running"] } },
      select: { id: true, status: true, progressAt: true, startedAt: true, progress: true, assignedAgentId: true },
    }),
    backupFreshness(db, now),
  ]);

  const thresholds = normalizeAlerts(alertsRaw);
  const offlineMs = thresholds.agentOfflineMinutes * 60_000;
  const migrationTarget = migrationRaw?.targetUrl?.trim() || null;
  const targetNorm = normalizeUrl(migrationTarget);

  // Agent roll-up (online state / build-current / standby) from the pure core.
  const rollInputs: AgentInput[] = agents.map((a) => ({
    id: a.id, clientId: a.clientId, priority: a.priority ?? 100,
    lastSeenAtMs: a.lastSeenAt ? a.lastSeenAt.getTime() : null, version: a.version,
  }));
  const rollups = rollUpAgents(rollInputs, build, nowMs, offlineMs);
  const rollById = new Map(rollups.map((r) => [r.id, r]));
  const agentSummary = summarizeAgents(rollups);

  // Which agent owns a wedged in-flight job, and its last progress phase → "stuck on <phase>".
  const stuckByAgent = new Map<string, string | null>();
  for (const j of inflight) {
    if (!j.assignedAgentId) continue;
    if (!jobIsWedged({ status: j.status, progressAtMs: j.progressAt ? j.progressAt.getTime() : null, startedAtMs: j.startedAt ? j.startedAt.getTime() : null }, nowMs)) continue;
    const prog = Array.isArray(j.progress) ? (j.progress as { phase?: string }[]) : [];
    const phase = prog.length ? prog[prog.length - 1]?.phase ?? null : null;
    if (!stuckByAgent.has(j.assignedAgentId)) stuckByAgent.set(j.assignedAgentId, phase);
  }

  const agentVMs: FleetAgentVM[] = agents.map((a) => {
    const r = rollById.get(a.id)!;
    const cur = normalizeUrl(a.currentAppUrl);
    const migrationState: FleetAgentVM["migrationState"] = !targetNorm
      ? "n/a"
      : a.migrateError
        ? "error"
        : cur && cur === targetNorm
          ? "on target"
          : a.currentAppUrl
            ? "pending"
            : "unknown";
    return {
      id: a.id,
      name: a.name,
      scope: a.scope,
      clientName: a.client?.name ?? null,
      clientSlug: a.client?.slug ?? null,
      onlineState: r.onlineState,
      lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
      bootAt: a.bootAt?.toISOString() ?? null,
      semver: a.semver,
      buildShort: a.version ? a.version.slice(0, 12) : null,
      buildCurrent: r.buildCurrent,
      standby: r.standby,
      stuckPhase: stuckByAgent.get(a.id) ?? null,
      capabilities: parseCapabilities(a.capabilities),
      currentAppUrl: a.currentAppUrl ?? null,
      migratedAt: a.migratedAt?.toISOString() ?? null,
      migrateError: a.migrateError ?? null,
      migrationState,
    };
  });

  // Queue: claimable pending depth (same filter as the claim candidate query), oldest-pending age
  // (Job has no createdAt — use the carrying case's createdAt), plus in-flight + reclaim counts.
  const pendingWhere: Prisma.JobWhereInput = { status: "pending", mode: "api", case: { deletedAt: null, pausedAt: null, status: { not: "completed" } } };
  const dayAgo = new Date(nowMs - 24 * 3_600_000);
  const windowStart = new Date(nowMs - thresholds.failureWindowMinutes * 60_000);
  const [pending, dispatched, running, oldestPending, autoStopped24h, failInWindow, fail24h, failRows] = await Promise.all([
    db.job.count({ where: pendingWhere }),
    db.job.count({ where: { status: "dispatched", mode: "api" } }),
    db.job.count({ where: { status: "running", mode: "api" } }),
    db.job.findFirst({ where: pendingWhere, orderBy: { case: { createdAt: "asc" } }, select: { case: { select: { createdAt: true } } } }),
    db.job.count({ where: { status: "failed", finishedAt: { gte: dayAgo }, request: { path: ["autoStopped"], equals: true } } }),
    db.job.count({ where: { status: "failed", finishedAt: { gte: windowStart } } }),
    db.job.count({ where: { status: "failed", finishedAt: { gte: dayAgo } } }),
    db.job.findMany({ where: { status: "failed", finishedAt: { gte: windowStart } }, select: { systemKey: true, case: { select: { client: { select: { name: true } } } } }, take: 500 }),
  ]);

  const wedged = inflight.filter((j) => jobIsWedged({ status: j.status, progressAtMs: j.progressAt ? j.progressAt.getTime() : null, startedAtMs: j.startedAt ? j.startedAt.getTime() : null }, nowMs)).length;
  const staleDispatched = inflight.filter((j) => jobIsStaleDispatched({ status: j.status, progressAtMs: j.progressAt ? j.progressAt.getTime() : null, startedAtMs: j.startedAt ? j.startedAt.getTime() : null }, nowMs)).length;
  const oldestPendingAgeMinutes = oldestPending?.case?.createdAt ? Math.round((nowMs - oldestPending.case.createdAt.getTime()) / 60_000) : null;

  const queue: QueueVM = { pending, dispatched, running, oldestPendingAgeMinutes, wedged, staleDispatched, autoStopped24h };
  const clusters = clusterFailures(failRows.map((f) => ({ clientName: f.case?.client?.name ?? null, systemKey: f.systemKey })));

  // DB health — the cheap SELECT 1 + client count (the expensive per-integration vendor sweep stays on
  // /health; a 25s poll must not hammer every vendor API). DB-down is a BOARD-ONLY signal (no alert).
  let dbUp = true, dbClients: number | null = null, dbDetail = "SELECT 1 ok";
  try {
    await db.$queryRaw`SELECT 1`;
    dbClients = await db.client.count();
    dbDetail = `SELECT 1 ok · ${dbClients} clients`;
  } catch (e) {
    dbUp = false;
    dbDetail = e instanceof Error ? e.message : String(e);
  }

  const alertState = normalizeAlertState(alertStateRaw);
  const firing = Object.entries(alertState.rules).map(([key, v]) => ({ key, firedAt: v.firedAt })).sort((a, b) => a.key.localeCompare(b.key));

  // Board-detected standing conditions (independent of whether an alert has fired) — drives the header
  // verdict. These mirror the alert rules plus DB-down (which is deliberately board-only).
  const conditions: string[] = [];
  if (!dbUp) conditions.push("Database unreachable");
  if (agentSummary.offline > 0) conditions.push(`${agentSummary.offline} agent(s) offline`);
  if (queue.pending >= thresholds.queueDepth && oldestPendingAgeMinutes !== null && oldestPendingAgeMinutes >= thresholds.queueBacklogMinutes) conditions.push(`Queue backing up (${queue.pending} pending)`);
  if (queue.wedged > 0) conditions.push(`${queue.wedged} wedged job(s)`);
  if (failInWindow >= thresholds.failureCount) conditions.push(`${failInWindow} failures in ${thresholds.failureWindowMinutes} min`);
  if (freshness.backupStale) conditions.push("Backup stale");
  if (agentSummary.total > 0 && agentSummary.buildCurrent < agentSummary.total) conditions.push(`${agentSummary.total - agentSummary.buildCurrent} agent(s) on an old build`);

  return {
    at: now.toISOString(),
    build: { id: build, short: buildShort, version: runnerVersion() },
    agents: agentVMs,
    agentSummary,
    migrationTarget,
    queue,
    failures: { window: thresholds.failureWindowMinutes, inWindow: failInWindow, last24h: fail24h, clusters },
    backups: freshness,
    db: { up: dbUp, clients: dbClients, detail: dbDetail },
    alerts: { thresholds, firing, lastSweepAt: alertState.lastSweepAt ?? null },
    conditions,
  };
}
