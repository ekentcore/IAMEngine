// Maintenance / graceful-drain toggle (feature #7). GET returns the current state + the in-flight
// count (dispatched + running) so the settings card can poll a live "draining… / fully drained"
// readout; POST writes a new state (enter / exit / scope change). Both guarded to settings.manage —
// the same blast radius as agent management and the app-URL migration (super/global admin, NOT
// ops_manager), matching how changeAppUrl is gated. Reuses AppSetting `maintenance.state`; no schema.
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting, claimAppSetting } from "@/lib/settings";
import {
  MAINTENANCE_KEY,
  EMPTY_MAINTENANCE,
  normalizeMaintenance,
  maintenanceActive,
  type MaintenanceState,
} from "@/lib/jobs/maintenance";

export const dynamic = "force-dynamic";

// In-flight = jobs the fleet is mid-execution on. This reaching 0 under a global drain is the
// cutover-safe signal (the leftover `pending` jobs are simply withheld, not in-flight).
async function inFlightCount(): Promise<number> {
  return db.job.count({ where: { status: { in: ["dispatched", "running"] } } });
}

export async function GET() {
  const g = await guardAuth();
  if (g.res) return g.res;
  const state = normalizeMaintenance(await getAppSetting<Partial<MaintenanceState>>(db, MAINTENANCE_KEY));
  const inFlight = await inFlightCount();
  // Emit the "fully drained — safe to cut over" audit EXACTLY ONCE on the >0 → 0 transition of a
  // global drain. Guard on the absence of drainedAt and claim it race-safely (claimAppSetting), so
  // concurrent status polls don't each write the line. drainedAt is cleared by any POST change.
  if (state.global && inFlight === 0 && !state.drainedAt) {
    const drainedAt = new Date().toISOString();
    const claimed = await claimAppSetting(db, MAINTENANCE_KEY, state, { ...state, drainedAt });
    if (claimed) {
      state.drainedAt = drainedAt;
      await recordAudit("maintenance.drained", { actor: "system", detail: { drainedAt, reason: state.reason ?? null } });
    }
  }
  return NextResponse.json({ ok: true, state, inFlight });
}

type PostBody = { global?: unknown; systems?: unknown; clients?: unknown; reason?: unknown };

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  const body = (await req.json().catch(() => ({}))) as PostBody;

  const prev = normalizeMaintenance(await getAppSetting<Partial<MaintenanceState>>(db, MAINTENANCE_KEY));
  // Build the desired state from the request, then normalize (dedupe/coerce). Clearing = posting
  // { global:false, systems:[], clients:[] }. drainedAt is intentionally NOT carried over — any
  // change re-arms the once-only "fully drained" signal.
  const next = normalizeMaintenance({
    global: body.global === true,
    systems: Array.isArray(body.systems) ? (body.systems as unknown[]).filter((s): s is string => typeof s === "string") : [],
    clients: Array.isArray(body.clients) ? (body.clients as unknown[]).filter((c): c is string => typeof c === "string") : [],
    reason: typeof body.reason === "string" ? body.reason : undefined,
    // Preserve `since` only while maintenance stays continuously active; stamp a fresh one otherwise.
    since: maintenanceActive(prev) ? prev.since : undefined,
  });
  const nowActive = maintenanceActive(next);
  if (nowActive && !next.since) next.since = new Date().toISOString();
  next.by = g.user.system ? "system" : g.user.email;

  // Race-safe write: two admins toggling at once can't silently clobber each other — the loser gets
  // false and the last-writer state is what the row holds. Fall back to an unconditional upsert if
  // the conditional claim missed (idempotent value; the caller re-reads via GET regardless).
  const ok = await claimAppSetting(db, MAINTENANCE_KEY, await getAppSetting(db, MAINTENANCE_KEY), next);
  if (!ok) await setAppSetting(db, MAINTENANCE_KEY, next);

  // enter / exit / change — for the audit trail. entering-from-clear = enter; clearing = exit; else change.
  const action = !maintenanceActive(prev) && nowActive ? "maintenance.enter" : !nowActive ? "maintenance.exit" : "maintenance.change";
  await recordAudit(action, { user: g.user, detail: { global: next.global, systems: next.systems, clients: next.clients, reason: next.reason ?? null } });

  return NextResponse.json({ ok: true, state: next, inFlight: await inFlightCount() });
}
