// Azure-cutover DB-move verification route (feature #2). Runs ON THE NEW (Azure) host after the restore:
// it recomputes row counts + the Secret→Delinea reference hash on the current DB and diffs them against
// the baseline that travelled inside the dump, then live-samples Delinea resolvability FROM THIS HOST.
// Guard settings.manage. No cross-origin calls — everything is local DB + this host's own Delinea egress.
//
// D1 (the blocking infra unknown): whether Azure has egress to Delinea with a working broker account is
// NOT assumed. sampleDelinea returns reachable:false when no token can be obtained, and verifyDbMove
// makes that a RED/unknown verdict — never a false green.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting, claimAppSetting } from "@/lib/settings";
import { CUTOVER_KEY, normalizeCutover, canAdvance, type CutoverState } from "@/lib/jobs/cutover";
import { snapshotDb, sampleDelinea, verifyDbMove } from "@/lib/jobs/cutover-db";
import { delineaConfigFromEnv } from "@/lib/secrets/delinea";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;
  const body = (await req.json().catch(() => ({}))) as { perClient?: unknown };
  const perClient = typeof body.perClient === "number" && body.perClient >= 0 ? Math.floor(body.perClient) : undefined;

  const prevRaw = await getAppSetting<unknown>(db, CUTOVER_KEY);
  const state = normalizeCutover(prevRaw);
  if (!state.baseline) {
    return NextResponse.json({ error: "no baseline to verify against — stage the cutover on the source host first (the baseline travels inside the dump)" }, { status: 409 });
  }

  // Recount on THIS (restored) host + live-sample Delinea from here.
  const current = await snapshotDb(db);
  const cfg = delineaConfigFromEnv();
  const delinea = await sampleDelinea(cfg, current.secretRefs, undefined, perClient !== undefined ? { perClient } : {});
  const result = verifyDbMove({ baseline: state.baseline, current, delinea }, new Date());

  // Persist onto cutover.dbVerify, and advance the phase into verifying-db when we're mid-push (a nice
  // stepper cue; guarded so it never illegally jumps). Race-safe write with fallback.
  const nextPhase: CutoverState["phase"] = canAdvance(state, "verifying-db") ? "verifying-db" : state.phase;
  const next: CutoverState = { ...state, dbVerify: result, phase: nextPhase };
  const ok = await claimAppSetting(db, CUTOVER_KEY, prevRaw, next);
  if (!ok) {
    const fresh = normalizeCutover(await getAppSetting<unknown>(db, CUTOVER_KEY));
    await setAppSetting(db, CUTOVER_KEY, { ...fresh, dbVerify: result });
  }

  await recordAudit("cutover.db_verify", {
    user: g.user,
    detail: {
      ok: result.ok,
      shrankOrMissing: result.tables.filter((t) => t.status === "shrank" || t.status === "missing").map((t) => t.name),
      unexpectedGrowth: result.tables.filter((t) => t.status === "grew" && !t.ok).map((t) => t.name),
      secretRefMatch: result.secretRefMatch,
      delineaConfigured: result.delineaConfigured,
      delineaReachable: result.delineaReachable,
      sampled: result.sampled,
      unresolvable: result.unresolvable.length,
    },
  });

  return NextResponse.json({ ok: true, result });
}
