// Azure-cutover control route (feature #2). The single write path for the guided move's phase
// transitions. Guard settings.manage — the same blast radius as agent management and the app-URL
// migration (super/global admin, NOT ops_manager), matching how changeAppUrl / agent-migration gate.
//
// It reuses the ALREADY-BUILT machinery and invents no runner directive:
//   • push / rollback only write the existing `agent_migration` AppSetting, which
//     runner-service.heartbeat already turns into `migrate:{appUrl}` — no runner file changes.
//   • the drain precondition reads feature #7's maintenance state (it does not own draining).
//   • the phase record lives in one AppSetting key (`cutover`), no schema change.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting, claimAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, normalizeUrl } from "@/lib/jobs/agent-migration";
import { MAINTENANCE_KEY, normalizeMaintenance, type MaintenanceState } from "@/lib/jobs/maintenance";
import {
  CUTOVER_KEY, normalizeCutover, canAct, nextPhase, agentRehomeVerdict, fleetRehomeSummary, canConfirm,
  type CutoverState, type CutoverAction, type AgentRehomeInput,
} from "@/lib/jobs/cutover";
import { computeBaseline, snapshotDb } from "@/lib/jobs/cutover-db";
import { probeUrl } from "@/lib/jobs/cutover-probe";

export const dynamic = "force-dynamic";

function isAbsoluteHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

// The fleet's current common URL (the mode across enabled agents) — captured at stage time as the
// rollback target. If agents disagree, that itself is a pre-existing split the console surfaces.
async function commonAgentUrl(): Promise<{ url: string | null; disagreement: string[] }> {
  const agents = await db.agent.findMany({ where: { deletedAt: null, enabled: true }, select: { currentAppUrl: true } });
  const counts = new Map<string, number>();
  for (const a of agents) {
    const u = a.currentAppUrl?.trim();
    if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  if (counts.size === 0) return { url: null, disagreement: [] };
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { url: sorted[0][0], disagreement: sorted.map(([u]) => u) };
}

async function loadState(): Promise<CutoverState> {
  return normalizeCutover(await getAppSetting<unknown>(db, CUTOVER_KEY));
}

// Persist the next state race-safely (two admins can't clobber the machine); fall back to an
// unconditional write if the conditional claim missed (idempotent value; caller re-reads via the loader).
async function persist(prevRaw: unknown, next: CutoverState): Promise<void> {
  const ok = await claimAppSetting(db, CUTOVER_KEY, prevRaw, next);
  if (!ok) await setAppSetting(db, CUTOVER_KEY, next);
}

async function rehomeVerdicts(azureUrl: string) {
  const agents = await db.agent.findMany({
    where: { deletedAt: null, enabled: true },
    select: {
      id: true, name: true, currentAppUrl: true, migrateRequested: true, migrateRequestedBy: true,
      migrateDeliveredAt: true, migratedAt: true, migrateError: true, lastSeenAt: true,
    },
  });
  const now = Date.now();
  const inputs: AgentRehomeInput[] = agents.map((a) => ({
    id: a.id, name: a.name, currentAppUrl: a.currentAppUrl,
    migrateRequested: a.migrateRequested, migrateRequestedBy: a.migrateRequestedBy,
    migrateDeliveredAt: a.migrateDeliveredAt?.toISOString() ?? null,
    migratedAt: a.migratedAt?.toISOString() ?? null,
    migrateError: a.migrateError,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
  }));
  return fleetRehomeSummary(inputs.map((a) => agentRehomeVerdict(a, azureUrl, now)));
}

type PostBody = { action?: unknown; azureUrl?: unknown; force?: unknown };

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  const body = (await req.json().catch(() => ({}))) as PostBody;
  const action = body.action as CutoverAction | undefined;
  if (!action || !["stage", "push", "confirm", "rollback", "ackStragglers"].includes(action)) {
    return NextResponse.json({ error: "unknown action" }, { status: 422 });
  }

  const prevRaw = await getAppSetting<unknown>(db, CUTOVER_KEY);
  const state = normalizeCutover(prevRaw);
  const actor = g.user.system ? "system" : g.user.email;

  if (action !== "ackStragglers" && !canAct(state, action)) {
    return NextResponse.json({ error: `cannot ${action} from phase "${state.phase}"` }, { status: 409 });
  }

  // ── stage ──────────────────────────────────────────────────────────────────────────────────────
  if (action === "stage") {
    const azureUrl = typeof body.azureUrl === "string" ? body.azureUrl.trim() : "";
    if (!isAbsoluteHttpUrl(azureUrl)) return NextResponse.json({ error: "azureUrl must be an absolute http(s) URL" }, { status: 422 });
    const { url: oldUrl, disagreement } = await commonAgentUrl();
    if (normalizeUrl(oldUrl) === normalizeUrl(azureUrl)) {
      return NextResponse.json({ error: "the fleet is already on that URL — nothing to cut over" }, { status: 422 });
    }
    // Capture the baseline INSIDE the DB so it travels in pg_dump. Write the staged record FIRST (so the
    // cutover AppSetting row exists and is counted), then snapshot, then fold the baseline in — this keeps
    // the AppSetting count in the baseline consistent with what the dump will carry.
    const staged: CutoverState = {
      ...state, phase: nextPhase(state, "stage"), azureUrl, oldUrl: oldUrl ?? state.oldUrl,
      startedBy: actor, stagedAt: new Date().toISOString(), baseline: null, dbVerify: null,
      acknowledgedStragglers: false, pushedAt: null, completedAt: null, rolledBackAt: null,
    };
    await persist(prevRaw, staged);
    const snap = await snapshotDb(db);
    const baseline = computeBaseline(snap, new Date());
    const withBaseline: CutoverState = { ...staged, baseline };
    await setAppSetting(db, CUTOVER_KEY, withBaseline);
    await recordAudit("cutover.stage", { user: g.user, detail: { azureUrl, oldUrl, disagreement: disagreement.length > 1 ? disagreement : undefined, baselineTables: Object.keys(baseline.tables).length, secretCount: baseline.secretCount } });
    return NextResponse.json({ ok: true, state: withBaseline, oldUrlDisagreement: disagreement.length > 1 ? disagreement : null });
  }

  // ── push ───────────────────────────────────────────────────────────────────────────────────────
  if (action === "push") {
    if (!state.azureUrl) return NextResponse.json({ error: "stage an Azure URL first" }, { status: 409 });
    // Precondition: feature #7's drain must be engaged (dispatch frozen) and, unless forced, in-flight
    // work must have reached zero. This is the structural split-brain guard — never push the fleet at
    // the new host while the old one is still executing jobs.
    const maint = normalizeMaintenance(await getAppSetting<Partial<MaintenanceState>>(db, MAINTENANCE_KEY));
    if (!maint.global) return NextResponse.json({ error: "engage the global drain (maintenance) before pushing — dispatch must be frozen on the old host first" }, { status: 409 });
    const inFlight = await db.job.count({ where: { status: { in: ["dispatched", "running"] } } });
    if (inFlight > 0 && body.force !== true) {
      return NextResponse.json({ error: `${inFlight} job(s) still in flight — wait for the drain to reach zero (or force)`, inFlight }, { status: 409 });
    }
    // Write the EXISTING fleet-migrate switch. The heartbeat does the rest (Invoke-CtgMigrate on each agent).
    await setAppSetting(db, AGENT_MIGRATION_KEY, { enabled: true, targetUrl: state.azureUrl, proofAgentId: null });
    const pushed: CutoverState = { ...state, phase: nextPhase(state, "push"), pushedAt: new Date().toISOString() };
    await persist(prevRaw, pushed);
    await recordAudit("cutover.push", { user: g.user, detail: { targetUrl: state.azureUrl, inFlight } });
    await recordAudit("agent.migration.configure", { user: g.user, detail: { enabled: true, targetUrl: state.azureUrl, proofAgentId: null, via: "cutover" } });
    return NextResponse.json({ ok: true, state: pushed });
  }

  // ── confirm ────────────────────────────────────────────────────────────────────────────────────
  if (action === "confirm") {
    const summary = await rehomeVerdicts(state.azureUrl);
    const verdict = canConfirm(state, summary);
    if (!verdict.ok) return NextResponse.json({ error: `cannot confirm — ${verdict.reason}`, summary }, { status: 409 });
    const done: CutoverState = { ...state, phase: nextPhase(state, "confirm"), completedAt: new Date().toISOString() };
    await persist(prevRaw, done);
    // Leave agent_migration.enabled=true so late/offline agents still re-home when they surface (the old
    // app stays up as the redirect "lighthouse").
    await recordAudit("cutover.confirm", { user: g.user, detail: { azureUrl: state.azureUrl, summary } });
    return NextResponse.json({ ok: true, state: done });
  }

  // ── rollback ───────────────────────────────────────────────────────────────────────────────────
  if (action === "rollback") {
    if (!state.oldUrl) return NextResponse.json({ error: "no captured old URL to roll back to" }, { status: 409 });
    // Safety: the old host must still be reachable, or agents told to go back would strand on a dead URL.
    const reach = await probeUrl(state.oldUrl);
    if (!reach.ok && body.force !== true) {
      return NextResponse.json({ error: `the old host (${state.oldUrl}) is not reachable — ${reach.detail}. Roll back only once it is back up (or force)` }, { status: 409 });
    }
    // Symmetric: migrateDecision emits while current != target, so pointing the target back at oldUrl
    // re-homes the whole fleet to the Mac on the next heartbeat; Invoke-CtgMigrate verifies reachability
    // before switching, so it is safe.
    await setAppSetting(db, AGENT_MIGRATION_KEY, { enabled: true, targetUrl: state.oldUrl, proofAgentId: null });
    const back: CutoverState = { ...state, phase: nextPhase(state, "rollback"), rolledBackAt: new Date().toISOString() };
    await persist(prevRaw, back);
    await recordAudit("cutover.rollback", { user: g.user, detail: { targetUrl: state.oldUrl, oldHostReachable: reach.ok } });
    await recordAudit("agent.migration.configure", { user: g.user, detail: { enabled: true, targetUrl: state.oldUrl, proofAgentId: null, via: "cutover-rollback" } });
    return NextResponse.json({ ok: true, state: back });
  }

  // ── ackStragglers ────────────────────────────────────────────────────────────────────────────────
  if (action === "ackStragglers") {
    if (!canAct(state, "ackStragglers")) return NextResponse.json({ error: `cannot acknowledge stragglers from phase "${state.phase}"` }, { status: 409 });
    const acked: CutoverState = { ...state, acknowledgedStragglers: true };
    await persist(prevRaw, acked);
    await recordAudit("cutover.ack_stragglers", { user: g.user });
    return NextResponse.json({ ok: true, state: acked });
  }

  return NextResponse.json({ error: "unhandled action" }, { status: 422 });
}
