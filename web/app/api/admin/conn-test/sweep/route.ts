// POST /api/admin/conn-test/sweep — queue connection/permission preflights for EVERY modeled active
// client at once (one per testable api system). Runners claim them on their next poll; results show
// on /health/connections. Replaces any prior run per client. Guarded like the per-client test.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";

export const dynamic = "force-dynamic";

export async function POST() {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const out = await makeRunnerService(db).requestConnectionTestsForAll();
  await recordAudit("conntest.sweep", { user: g.user, detail: out });
  return NextResponse.json({ ok: true, ...out });
}
