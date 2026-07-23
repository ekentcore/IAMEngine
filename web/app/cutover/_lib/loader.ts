// Cutover console (feature #2) — read-only data assembly for /cutover. Reads the `cutover` state, the
// `agent_migration` setting, and the enabled-agent rows, then derives the per-agent re-home board and
// the confirm/rollback gates PURELY (lib/jobs/cutover.ts). It reuses feature #3's online window and the
// shared migrateStatus verdict; it dispatches nothing and mutates nothing.
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/auth/permissions";
import { getAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, normalizeUrl, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
import { MAINTENANCE_KEY, normalizeMaintenance, type MaintenanceState } from "@/lib/jobs/maintenance";
import { migrateStatus } from "@/lib/agents/migrate-status";
import {
  CUTOVER_KEY, normalizeCutover, agentRehomeVerdict, fleetRehomeSummary, canConfirm, canAct,
  type CutoverState, type RehomeVerdict, type FleetRehomeSummary, type AgentRehomeInput,
} from "@/lib/jobs/cutover";
import { probeUrl, type ProbeResult } from "@/lib/jobs/cutover-probe";

export type CutoverAgentRow = RehomeVerdict & {
  scope: string;
  clientName: string | null;
  currentAppUrl: string | null;
  lastSeenAt: string | null;
  statusLabel: string | null; // the raw shared migrateStatus label, shown under the chip
};

export type CutoverVM = {
  at: string;
  state: CutoverState;
  migration: { enabled: boolean; targetUrl: string | null };
  agents: CutoverAgentRow[]; // worst-first
  summary: FleetRehomeSummary;
  drain: { global: boolean; inFlight: number; quiesced: boolean };
  oldHostReachable: ProbeResult | null;
  azureHostReachable: ProbeResult | null;
  gates: {
    canStage: boolean;
    canPush: boolean;
    pushBlockedReason: string | null;
    canConfirm: boolean;
    confirmBlockedReason: string | null;
    canRollback: boolean;
    rollbackBlockedReason: string | null;
  };
};

const KIND_RANK: Record<RehomeVerdict["kind"], number> = { red: 0, pending: 1, green: 2 };

export async function loadCutover(now: Date = new Date()): Promise<CutoverVM> {
  // Gate: settings.manage — the same super/global-admin blast radius as agent management and the
  // app-URL migration that this console orchestrates.
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || !can(me.role, "settings.manage")) redirect("/clients");
  }

  const [cutoverRaw, migrationRaw, maintRaw, agents, inFlight] = await Promise.all([
    getAppSetting<unknown>(db, CUTOVER_KEY),
    getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY),
    getAppSetting<Partial<MaintenanceState>>(db, MAINTENANCE_KEY),
    db.agent.findMany({
      where: { deletedAt: null, enabled: true },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, scope: true, currentAppUrl: true, lastSeenAt: true,
        migrateRequested: true, migrateRequestedBy: true, migrateDeliveredAt: true, migratedAt: true, migrateError: true,
        client: { select: { name: true } },
      },
    }),
    db.job.count({ where: { status: { in: ["dispatched", "running"] } } }),
  ]);

  const state = normalizeCutover(cutoverRaw);
  const maint = normalizeMaintenance(maintRaw);
  const nowMs = now.getTime();
  const azureUrl = state.azureUrl || (migrationRaw?.targetUrl?.trim() ?? "");

  const rows: CutoverAgentRow[] = agents.map((a) => {
    const input: AgentRehomeInput = {
      id: a.id, name: a.name, scope: a.scope, clientName: a.client?.name ?? null,
      currentAppUrl: a.currentAppUrl,
      migrateRequested: a.migrateRequested, migrateRequestedBy: a.migrateRequestedBy,
      migrateDeliveredAt: a.migrateDeliveredAt?.toISOString() ?? null,
      migratedAt: a.migratedAt?.toISOString() ?? null,
      migrateError: a.migrateError,
      lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
    };
    const verdict = agentRehomeVerdict(input, azureUrl || null, nowMs);
    const st = migrateStatus(input, azureUrl || null, nowMs);
    return {
      ...verdict,
      scope: a.scope,
      clientName: a.client?.name ?? null,
      currentAppUrl: a.currentAppUrl ?? null,
      lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
      statusLabel: st?.label ?? null,
    };
  });
  rows.sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.name.localeCompare(y.name));
  const summary = fleetRehomeSummary(rows);

  const quiesced = maint.global && inFlight === 0;

  // Live reachability — only worth probing once a URL is staged. Both are best-effort (never throw).
  const [oldHostReachable, azureHostReachable] = await Promise.all([
    state.oldUrl ? probeUrl(state.oldUrl) : Promise.resolve<ProbeResult | null>(null),
    azureUrl ? probeUrl(azureUrl) : Promise.resolve<ProbeResult | null>(null),
  ]);

  // ── gate derivation (mirrors the route's server-side checks so the buttons agree) ────────────────
  const canStage = canAct(state, "stage");

  let canPush = canAct(state, "push");
  let pushBlockedReason: string | null = null;
  if (canPush) {
    if (!maint.global) { canPush = false; pushBlockedReason = "engage the global drain first (dispatch must be frozen on the old host)"; }
    else if (inFlight > 0) { canPush = false; pushBlockedReason = `${inFlight} job(s) still in flight — wait for the drain to reach zero`; }
  }

  const confirmVerdict = canConfirm(state, summary);

  let canRollback = canAct(state, "rollback");
  let rollbackBlockedReason: string | null = null;
  if (canRollback) {
    if (!state.oldUrl) { canRollback = false; rollbackBlockedReason = "no captured old URL to roll back to"; }
    else if (oldHostReachable && !oldHostReachable.ok) { canRollback = false; rollbackBlockedReason = `the old host is not reachable (${oldHostReachable.detail})`; }
  }

  return {
    at: now.toISOString(),
    state,
    migration: { enabled: migrationRaw?.enabled === true, targetUrl: migrationRaw?.targetUrl?.trim() || null },
    agents: rows,
    summary,
    drain: { global: maint.global, inFlight, quiesced },
    oldHostReachable,
    azureHostReachable,
    gates: {
      canStage,
      canPush,
      pushBlockedReason,
      canConfirm: confirmVerdict.ok,
      confirmBlockedReason: confirmVerdict.ok ? null : confirmVerdict.reason ?? null,
      canRollback,
      rollbackBlockedReason,
    },
  };
}

// A cheap helper the view uses to decide whether the migration target actually points where the console
// thinks it does (surfaces a manual out-of-band change to agent_migration during the window).
export function migrationTargetMatchesCutover(vm: CutoverVM): boolean {
  if (!vm.state.azureUrl || vm.state.phase === "idle" || vm.state.phase === "staged") return true;
  const expected = vm.state.phase === "rolled-back" ? vm.state.oldUrl : vm.state.azureUrl;
  return normalizeUrl(vm.migration.targetUrl) === normalizeUrl(expected);
}
