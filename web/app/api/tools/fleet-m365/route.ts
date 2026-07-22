// POST   /api/tools/fleet-m365 — start a fleet-wide M365-family connection-test sweep.
// GET     /api/tools/fleet-m365 — advance the live sweep + return the per-client roll-up (the page poll).
// DELETE  /api/tools/fleet-m365 — cancel the live sweep.
//
// Fleet-wide + mutating (it queues tests across every M365 client): requires client.edit_secrets AND
// all-clients access, scope-filtered per client — same gate as the fleet M365 setup route.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { scopeAllows } from "@/lib/auth/client-scope";
import { auditActor, recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeRunnerService } from "@/lib/jobs/runner-service";
import { startFleetM365Test, retestFleetM365Client, rollupFleetM365Test, cancelFleetM365Test } from "@/lib/jobs/fleet-m365-test";
import { selfGrantM365Permissions } from "@/lib/secrets/self-grant-m365";

export const dynamic = "force-dynamic";

// POST with no body = start a full fleet sweep.
// POST { slug } = retest just that one client's M365 systems (the per-row "Retest").
// POST { slug, selfGrant, optionalRoles? } = grant the client's missing Graph roles using its own
//   AppRoleAssignment.ReadWrite.All (no Global Admin), then leave the row to be retested.
export async function POST(req: Request) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const access = await fleetWideAccess(db, g.user.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { slug?: string; selfGrant?: boolean; optionalRoles?: string[] };
  const slug = typeof body?.slug === "string" && body.slug.trim() ? body.slug.trim() : undefined;

  if (slug && body.selfGrant) {
    // Resolve the client (scope-gated: out of scope reads as not-found) + its m365-admin credential.
    const client = await db.client.findUnique({
      where: { slug },
      select: { id: true, primaryDomain: true, secrets: { where: { name: "m365-admin" }, select: { externalId: true } } },
    });
    if (!client || !scopeAllows(access.scope, client.id)) return NextResponse.json({ ok: false, reason: "not found" }, { status: 404 });
    const externalId = client.secrets[0]?.externalId;
    if (!externalId) return NextResponse.json({ ok: false, reason: "no m365-admin credential is wired for this client" }, { status: 422 });

    const optionalRoles = Array.isArray(body.optionalRoles) ? body.optionalRoles.filter((r) => typeof r === "string") : [];
    const r = await selfGrantM365Permissions({ externalId, primaryDomain: client.primaryDomain, optionalRoles });
    // Audit the outcome either way — self-granting Graph roles is a client-tenant permission change.
    await recordAudit("m365.grant.self", { user: g.user, clientId: client.id, detail: { slug, ok: r.ok, reason: r.reason, appId: r.appId, granted: r.granted, alreadyHad: r.alreadyHad, failed: r.failed } });
    if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason }, { status: 422 });
    return NextResponse.json({ ok: true, granted: r.granted, alreadyHad: r.alreadyHad, failed: r.failed });
  }

  if (slug) {
    const r = await retestFleetM365Client(db, makeRunnerService(db), slug, access.scope);
    if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason }, { status: r.reason === "not found" ? 404 : 422 });
    await recordAudit("fleet.m365.test.retest", { user: g.user, detail: { slug, tests: r.tests } });
    return NextResponse.json({ ok: true, tests: r.tests });
  }

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
