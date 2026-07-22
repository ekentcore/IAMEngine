// POST   /api/tools/fleet-m365 — start a fleet-wide M365-family connection-test sweep.
// GET     /api/tools/fleet-m365 — advance the live sweep + return the per-client roll-up (the page poll).
// DELETE  /api/tools/fleet-m365 — cancel the live sweep.
//
// Fleet-wide + mutating (it queues tests across every M365 client): requires client.edit_secrets AND
// all-clients access, scope-filtered per client — same gate as the fleet M365 setup route.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { startFleetM365Test, rollupFleetM365Test, cancelFleetM365Test } from "@/lib/jobs/fleet-m365-test";

export const dynamic = "force-dynamic";

export async function POST(_req: Request) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const access = await fleetWideAccess(db, g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });

  const r = await startFleetM365Test(db, makeRunnerService(db), { startedBy: auditActor(g.user, "ui").label, scope: access.scope });
  if (!r.started) return NextResponse.json({ started: false, reason: r.reason, id: r.id }, { status: 409 });
  await recordAudit("fleet.m365.test.start", { user: g.user, detail: { runId: r.id, clients: r.clients, tests: r.tests } });
  return NextResponse.json({ started: true, id: r.id, clients: r.clients, tests: r.tests });
}

export async function GET(_req: Request) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const access = await fleetWideAccess(db, g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });
  const rollup = await rollupFleetM365Test(db, access.scope);
  return NextResponse.json(rollup);
}

export async function DELETE(_req: Request) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const access = await fleetWideAccess(db, g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });
  const r = await cancelFleetM365Test(db);
  if (!r.cancelled) return NextResponse.json({ cancelled: false, reason: r.reason, id: r.id }, { status: 409 });
  await recordAudit("fleet.m365.test.cancel", { user: g.user, detail: { runId: r.id } });
  return NextResponse.json({ cancelled: true, id: r.id });
}
