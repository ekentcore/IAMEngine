// Go-live readiness preflight (feature #6) — the batched, READ-ONLY data assembly for /golive.
//
// The hard invariant: this NEVER dispatches to a runner. Everything cheap runs live in-process
// (runHealthChecks integrations, agent online/build/URL state, migration-table read, wedged-job count,
// per-client agent reachability); the async probes (M365 sign-ins, connection tests) are read from
// their LAST cached result via rollupFleetM365Test + computeClientReadiness. A fresh M365 sweep is an
// explicit operator button that reuses /api/tools/fleet-m365 — the loader never starts one.
//
// It reuses the existing signal helpers as-is (it re-derives nothing): runHealthChecks,
// rollupFleetM365Test, listClients(scope)/computeClientReadiness, runnerBuildId + agentBuildIsCurrent,
// computeReach, backupFreshness, migrateStatus. The only new logic is the pure registry evaluation
// (checks.ts) + the GO/NO-GO reducer (rollup.ts) + the migration-table read (migration-status.ts).
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { currentClientScope } from "@/lib/auth/client-scope";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { runHealthChecks } from "@/lib/health/checks";
import { rollupFleetM365Test, FLEET_M365_STALE_AFTER_MS } from "@/lib/jobs/fleet-m365-test";
import { makeClientRepository } from "@/lib/clients/repository";
import { runnerBuildId } from "@/lib/runner/bundle";
import { backupFreshness } from "@/lib/jobs/backup-freshness";
import { getAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
import { jobIsWedged } from "@/lib/fleet/health";
import { AGENT_ONLINE_MS, computeReach, type OnlineAgentRow } from "@/lib/runner/reachability";
import { ALWAYS_ON_PREM_SYSTEMS, systemIsOnPrem } from "@/lib/cases/case-secrets";
import { migrationStatus } from "@/lib/golive/migration-status";
import { GLOBAL_CHECKS, PER_CLIENT_CHECKS, type Snapshot, type AgentSnapshot, type ClientState, type CheckResult, type Verdict } from "@/lib/golive/checks";
import { rollupClient, overallVerdict, type ClientRollup, type OverallRollup } from "@/lib/golive/rollup";

export type GoLiveVM = {
  at: string;
  overall: OverallRollup;
  global: CheckResult[];
  clients: ClientRollup[]; // sorted worst-first
  m365SweepAgeMs: number | null;
  m365SweepStale: boolean;
  canRunSweep: boolean; // whether THIS operator may POST the fleet M365 sweep (edit_secrets + all-clients)
};

const VERDICT_RANK: Record<Verdict, number> = { fail: 3, warn: 2, na: 1, pass: 0 };

export async function loadGoLivePreflight(now: Date = new Date()): Promise<GoLiveVM> {
  // Gate: audit.view — the same infra-wide, cross-client read as /health/fleet and /health/connections.
  let canRunSweep = true;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "audit.view")) redirect("/clients");
    // The "Run fresh M365 sweep" button POSTs the guarded fleet route (edit_secrets + all-clients).
    canRunSweep = can(me.role, "client.edit_secrets") && (await fleetWideAccess(db, me.id)).ok;
  }
  const scope = await currentClientScope(db);
  const nowMs = now.getTime();
  const build = runnerBuildId();

  // ── one batched load ──────────────────────────────────────────────────────────────────────────
  const [health, m365, clientList, agents, migrationRaw, backups, migrations, runningJobs] = await Promise.all([
    runHealthChecks(),
    rollupFleetM365Test(db, scope), // cached ConnectionTest rows; advance-on-poll, never dispatches
    makeClientRepository(db).listClients(scope),
    db.agent.findMany({
      where: { enabled: true, deletedAt: null },
      select: {
        id: true, clientId: true, name: true, capabilities: true, lastSeenAt: true, version: true,
        currentAppUrl: true, migrateRequested: true, migrateRequestedBy: true, migrateDeliveredAt: true,
        migratedAt: true, migrateError: true,
      },
    }),
    getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY),
    backupFreshness(db, now),
    migrationStatus(db),
    db.job.findMany({ where: { mode: "api", status: "running" }, select: { status: true, progressAt: true, startedAt: true } }),
  ]);

  const migrationTarget = migrationRaw?.targetUrl?.trim() ? migrationRaw.targetUrl.trim() : null;

  const agentSnaps: AgentSnapshot[] = agents.map((a) => ({
    id: a.id,
    clientId: a.clientId,
    lastSeenAtMs: a.lastSeenAt ? a.lastSeenAt.getTime() : null,
    version: a.version,
    migrate: {
      migrateRequested: a.migrateRequested,
      migrateRequestedBy: a.migrateRequestedBy,
      migrateDeliveredAt: a.migrateDeliveredAt ? a.migrateDeliveredAt.toISOString() : null,
      migratedAt: a.migratedAt ? a.migratedAt.toISOString() : null,
      migrateError: a.migrateError,
      lastSeenAt: a.lastSeenAt ? a.lastSeenAt.toISOString() : null,
      currentAppUrl: a.currentAppUrl,
    },
  }));

  const wedgedJobs = runningJobs.filter((j) =>
    jobIsWedged({ status: j.status, progressAtMs: j.progressAt ? j.progressAt.getTime() : null, startedAtMs: j.startedAt ? j.startedAt.getTime() : null }, nowMs)
  ).length;

  // M365 sweep freshness (for the banner age + the "re-run" hint).
  const sweepAt = m365.run?.finishedAt ?? m365.run?.startedAt ?? null;
  const m365SweepAgeMs = sweepAt ? nowMs - Date.parse(sweepAt) : null;

  // ── go-live in-scope client filter ──────────────────────────────────────────────────────────────
  // Same population the top-20 build order targets: visible (scope already applied by listClients),
  // not archived, engine not opted out, has a backbone (roster-only rows aren't run against), modeled.
  // Parked clients (PGLS et al.) fall out via engineOptOut / unmodeled.
  const goLive = clientList.filter((c) => c.status !== "archived" && !c.engineOptOut && c.backbone != null && c.modeled);

  // M365 rollup rows by slug (only M365-family clients appear).
  const m365BySlug = new Map(m365.rows.map((r) => [r.slug, r]));

  // Online agents (enabled + within the 90s window) for pure reachability computation — no extra query.
  const onlineAgents: OnlineAgentRow[] = agents
    .filter((a) => a.lastSeenAt && nowMs - a.lastSeenAt.getTime() <= AGENT_ONLINE_MS)
    .map((a) => ({ clientId: a.clientId, name: a.name, capabilities: a.capabilities }));

  const clientStates: ClientState[] = goLive.map((c) => {
    const hasOnPremAd = c.systemKeys.some((k) => ALWAYS_ON_PREM_SYSTEMS.includes(k));
    const onPremKeys = c.systemKeys.filter((k) => systemIsOnPrem(k, hasOnPremAd));
    let agentReach: ClientState["agentReach"] = null;
    if (onPremKeys.length > 0) {
      // Only on-prem keys are passed, so needsOwnAgent is always true for them → pinsToOwnAgent is
      // irrelevant here; clientHasOnPremAd is true by construction. Pure, reuses the loaded agents.
      const reach = computeReach(onlineAgents, c.id, onPremKeys, { pinsToOwnAgent: false, clientHasOnPremAd: true });
      const entries = Object.values(reach);
      agentReach = {
        total: entries.length,
        servable: entries.filter((r) => r.servable).length,
        reasons: [...new Set(entries.map((r) => r.reason).filter((x): x is string => Boolean(x)))],
      };
    }
    const m365Row = m365BySlug.get(c.slug);
    return {
      slug: c.slug,
      name: c.name,
      readinessTier: c.readiness.tier,
      readinessSummary: c.readiness.summary,
      m365: m365Row ? { status: m365Row.status, tags: m365Row.tags, missingPerms: m365Row.missingPerms } : null,
      agentReach,
    };
  });

  const snapshot: Snapshot = {
    now: nowMs,
    health,
    agents: agentSnaps,
    build,
    migrationTarget, // migrateStatus normalizes for comparison; pass the raw target through
    migrations,
    backups,
    wedgedJobs,
    m365SweepAgeMs,
    m365SweepStaleMs: FLEET_M365_STALE_AFTER_MS,
    clients: clientStates,
  };

  // ── run the registry ──────────────────────────────────────────────────────────────────────────
  const globalResults = GLOBAL_CHECKS.map((chk) => chk.evaluate(snapshot));
  const clientRollups: ClientRollup[] = clientStates.map((c) => {
    const checks = PER_CLIENT_CHECKS.map((chk) => chk.evaluate(snapshot, c));
    return rollupClient(c.slug, c.name, checks);
  });
  // NO-GO clients first, then by name.
  clientRollups.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || a.name.localeCompare(b.name));

  const overall = overallVerdict(globalResults, clientRollups);

  return {
    at: now.toISOString(),
    overall,
    global: globalResults,
    clients: clientRollups,
    m365SweepAgeMs,
    m365SweepStale: m365SweepAgeMs === null || m365SweepAgeMs > FLEET_M365_STALE_AFTER_MS,
    canRunSweep,
  };
}
