// GET/PUT /api/admin/conn-test/schedule — the scheduled fleet credential-health sweep config
// (AppSetting conn_test_sweep). GET returns the current setting + last summary; PUT sets enabled +
// interval. The sweep itself runs off the runner heartbeat (see lib/jobs/conn-sweep.ts).
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { getAppSetting, setAppSetting } from "@/lib/settings";
import { CONN_SWEEP_KEY, normalizeConnSweep } from "@/lib/jobs/conn-sweep";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  return NextResponse.json(normalizeConnSweep(await getAppSetting(db, CONN_SWEEP_KEY)));
}

export async function PUT(req: Request) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const current = normalizeConnSweep(await getAppSetting(db, CONN_SWEEP_KEY));
  const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
  const intervalHours = typeof body.intervalHours === "number" && body.intervalHours >= 1 ? Math.floor(body.intervalHours) : current.intervalHours;
  const next = { ...current, enabled, intervalHours };
  await setAppSetting(db, CONN_SWEEP_KEY, next);
  await recordAudit("conntest.schedule", { user: g.user, detail: { enabled, intervalHours } });
  return NextResponse.json(next);
}
